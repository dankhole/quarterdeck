import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, opendir, realpath, rename, unlink } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";

import { desktopDiagnosticRecordDataSchema } from "../../src/core/api/desktop-diagnostics";
import { diagnosticRecordEnvelopeSchema, runtimeDiagnosticDescriptorSchema } from "../../src/core/api/diagnostics";
import { isFileSystemPathWithin } from "../../src/core/path-comparison";
import type { DesktopLabFixture } from "./desktop-fixture";
import { sameDesktopProcess } from "./desktop-processes";
import { type DesktopLabProcess, type DesktopProcessEvidence, DesktopProcessEvidenceSchema } from "./desktop-types";

export const DESKTOP_SHUTDOWN_CAPTURE_LIMITS = {
	durationMs: 2_000,
	instances: 64,
	segments: 8,
	segmentBytes: 128 * 1024,
	inputBytes: 2 * 1024 * 1024,
	outputBytes: 1024 * 1024,
	recordsPerInstance: 200,
} as const;

type CaptureIssue = "unavailable" | "invalid" | "outside_fixture" | "limit" | "deadline" | "write_failed";
type SafeProcess = Pick<DesktopLabProcess, "pid" | "parentPid">;
type DesktopDiagnosticRecordData = ReturnType<typeof desktopDiagnosticRecordDataSchema.parse>;
interface ShutdownRecord {
	sequence: number;
	timestamp: number;
	name: string;
	data?: DesktopDiagnosticRecordData;
}
interface ShutdownInstance {
	instanceId: string;
	pid: number;
	processKind: "desktop" | "runtime";
	status: "starting" | "ready" | "stopping" | "stopped" | "failed";
	records: ShutdownRecord[];
}
export interface DesktopShutdownEvidence {
	version: 1;
	attemptedAt: string | null;
	timedOutAt: string | null;
	main: SafeProcess | null;
	helper: SafeProcess | null;
	processEvidence: DesktopProcessEvidence | null;
	instances: ShutdownInstance[];
	issues: CaptureIssue[];
}
export interface DesktopShutdownCaptureOptions {
	attemptedAt: string;
	timedOutAt: string;
	originalMain: DesktopLabProcess | null;
	helper: DesktopLabProcess | null;
	/** Previously admitted identities, including exited helpers; these grant no cleanup authority. */
	retainedProcesses?: readonly DesktopLabProcess[];
}

const UUID = /^[a-f\d]{8}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{12}$/iu;
const FIXED_EVENTS = new Set([
	"desktop.recorder_closing",
	"desktop.recorder_closed",
	"runtime.shutdown_requested",
	"runtime.shutdown_completed",
]);

class CaptureFailure extends Error {
	constructor(readonly issue: CaptureIssue) {
		super(issue);
	}
}

function safeTime(value: string): string | null {
	return /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/u.test(value) && Number.isFinite(Date.parse(value)) ? value : null;
}

function safeProcess(value: DesktopLabProcess | null): SafeProcess | null {
	return value && Number.isSafeInteger(value.pid) && value.pid > 0 && Number.isSafeInteger(value.parentPid)
		? { pid: value.pid, parentPid: value.parentPid }
		: null;
}

/** Project fixed metadata only; generic journal payloads and context are never exported here. */
function projectRecord(line: string, instanceId: string): ShutdownRecord | null {
	let candidate: unknown;
	try {
		candidate = JSON.parse(line) as unknown;
	} catch {
		return null;
	}
	const parsed = diagnosticRecordEnvelopeSchema.safeParse(candidate);
	if (!parsed.success) return null;
	const record = parsed.data;
	if (
		record.runtimeInstanceId !== instanceId ||
		record.source !== "runtime" ||
		record.kind !== "event" ||
		!Number.isSafeInteger(record.sequence) ||
		!Number.isSafeInteger(record.timestamp)
	)
		return null;
	const base = { sequence: record.sequence, timestamp: record.timestamp, name: record.name };
	if (FIXED_EVENTS.has(record.name)) return base;
	if (!["desktop.shutdown", "desktop.generation", "desktop.lifecycle"].includes(record.name)) return null;
	if (!record.payload || typeof record.payload !== "object" || Array.isArray(record.payload)) return null;
	const payload = record.payload as Record<string, unknown>;
	// Owned-helper projections add observedAt and desktopSequence to this same canonical payload.
	const data = desktopDiagnosticRecordDataSchema.safeParse({ event: payload.event, state: payload.state });
	return data.success && record.name === `desktop.${data.data.event.kind}` ? { ...base, data: data.data } : null;
}

/** Preserve existing isolated journals before cleanup; this observes no runtime endpoint or renderer. */
export async function captureDesktopShutdownEvidence(
	fixture: DesktopLabFixture,
	options: DesktopShutdownCaptureOptions,
): Promise<DesktopShutdownEvidence> {
	const proof: DesktopShutdownEvidence = {
		version: 1,
		attemptedAt: safeTime(options.attemptedAt),
		timedOutAt: safeTime(options.timedOutAt),
		main: safeProcess(options.originalMain),
		helper: safeProcess(options.helper),
		processEvidence: null,
		instances: [],
		issues: [],
	};
	const controller = new AbortController();
	const mainPid = fixture.manifest.mainPid;
	const helperPid = fixture.manifest.helperPid;
	const admittedProcesses = fixture.manifest.processes;
	const isAdmittedIdentity = (process: DesktopLabProcess): boolean =>
		admittedProcesses.some(
			(admitted) => sameDesktopProcess(admitted, process) && admitted.parentPid === process.parentPid,
		);
	const issue = (value: CaptureIssue): void => {
		if (!proof.issues.includes(value)) proof.issues.push(value);
	};
	const check = (): void => {
		if (controller.signal.aborted) throw new CaptureFailure("deadline");
	};
	let inputBytes = 0;
	const contained = async (path: string, root: string): Promise<string> => {
		check();
		if (!isAbsolute(path) || !isFileSystemPathWithin(root, path)) throw new CaptureFailure("outside_fixture");
		const canonical = await realpath(path);
		check();
		if (canonical !== resolve(path) || !isFileSystemPathWithin(root, canonical))
			throw new CaptureFailure("outside_fixture");
		return canonical;
	};
	const read = async (path: string, root: string, bytes: number, tail = false): Promise<string> => {
		await contained(path, root);
		const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
		try {
			check();
			const info = await file.stat();
			if (!info.isFile()) throw new CaptureFailure("invalid");
			if (!tail && info.size > bytes) throw new CaptureFailure("limit");
			const length = Math.min(info.size, bytes);
			if (inputBytes + length > DESKTOP_SHUTDOWN_CAPTURE_LIMITS.inputBytes) throw new CaptureFailure("limit");
			inputBytes += length;
			const start = Math.max(0, info.size - length);
			const buffer = Buffer.alloc(length);
			const result = await file.read(buffer, 0, length, start);
			check();
			let text = buffer.subarray(0, result.bytesRead).toString("utf8");
			if (start > 0) {
				issue("limit");
				const boundary = text.indexOf("\n");
				text = boundary === -1 ? "" : text.slice(boundary + 1);
			}
			return text;
		} finally {
			await file.close();
		}
	};
	const entries = async (path: string, root: string): Promise<string[]> => {
		await contained(path, root);
		const names: string[] = [];
		for await (const entry of await opendir(path)) {
			check();
			if (names.length === DESKTOP_SHUTDOWN_CAPTURE_LIMITS.instances) {
				issue("limit");
				break;
			}
			names.push(entry.name);
		}
		return names;
	};
	const failure = (error: unknown): void => issue(error instanceof CaptureFailure ? error.issue : "unavailable");
	const work = async (): Promise<void> => {
		const artifact = await realpath(fixture.manifest.artifactDir);
		if (artifact !== resolve(fixture.manifest.artifactDir)) throw new CaptureFailure("outside_fixture");
		try {
			const temp = await realpath(fixture.config.tempRoot);
			if (temp !== resolve(fixture.config.tempRoot)) throw new CaptureFailure("outside_fixture");
			const state = await contained(fixture.config.stateHome, temp);
			if (
				!proof.main ||
				!options.originalMain ||
				proof.main.pid !== mainPid ||
				!isAdmittedIdentity(options.originalMain) ||
				(options.helper &&
					(!isAdmittedIdentity(options.helper) ||
						options.helper.parentPid !== proof.main.pid ||
						(helperPid !== null && options.helper.pid !== helperPid)))
			)
				throw new CaptureFailure("invalid");
			try {
				const parsed = DesktopProcessEvidenceSchema.safeParse(
					JSON.parse(await read(fixture.config.processEvidencePath, temp, 8 * 1024)) as unknown,
				);
				if (
					!parsed.success ||
					parsed.data.appPid !== proof.main.pid ||
					(parsed.data.generation !== null && !UUID.test(parsed.data.generation)) ||
					(parsed.data.runtimeOrigin !== null &&
						!/^http:\/\/127\.0\.0\.1:([1-9]\d{0,4})$/u.test(parsed.data.runtimeOrigin))
				)
					throw new CaptureFailure("invalid");
				if (parsed.data.runtimeOrigin !== null && Number(parsed.data.runtimeOrigin.split(":").at(-1)) > 65535)
					throw new CaptureFailure("invalid");
				const capturedHelper =
					options.helper ??
					options.retainedProcesses?.find(
						(process) =>
							process.pid === parsed.data.helperPid &&
							process.parentPid === proof.main?.pid &&
							isAdmittedIdentity(process),
					) ??
					null;
				// A null current helper PID means absence, not loss of its admitted historical identity.
				if (
					parsed.data.helperPid !== (capturedHelper?.pid ?? null) ||
					(helperPid !== null && helperPid !== parsed.data.helperPid)
				)
					throw new CaptureFailure("invalid");
				proof.helper = safeProcess(capturedHelper);
				proof.processEvidence = parsed.data;
			} catch (error) {
				failure(error);
			}
			try {
				const root = join(state, "diagnostics", "instances");
				for (const name of await entries(root, state)) {
					if (!UUID.test(name)) continue;
					try {
						const directory = join(root, name);
						const parsed = runtimeDiagnosticDescriptorSchema.safeParse(
							JSON.parse(await read(join(directory, "runtime.json"), state, 32 * 1024)) as unknown,
						);
						if (!parsed.success || parsed.data.runtimeInstanceId !== name) throw new CaptureFailure("invalid");
						const descriptor = parsed.data;
						if (
							!(
								(descriptor.pid === proof.main.pid && descriptor.processKind === "desktop") ||
								(descriptor.pid === proof.helper?.pid && descriptor.processKind === "runtime")
							)
						)
							continue;
						if (proof.instances.some((instance) => instance.pid === descriptor.pid)) {
							issue("invalid");
							continue;
						}
						const journal = join(directory, "journal");
						if (resolve(descriptor.journalDirectory) !== journal) throw new CaptureFailure("outside_fixture");
						const instance: ShutdownInstance = {
							instanceId: name,
							pid: descriptor.pid,
							processKind: descriptor.processKind,
							status: descriptor.status,
							records: [],
						};
						proof.instances.push(instance);
						const segments = (await entries(journal, state)).filter((file) => /^records-\d+\.jsonl$/u.test(file));
						if (segments.length > DESKTOP_SHUTDOWN_CAPTURE_LIMITS.segments) issue("limit");
						for (const segment of segments.sort().slice(-DESKTOP_SHUTDOWN_CAPTURE_LIMITS.segments)) {
							const content = await read(
								join(journal, segment),
								state,
								DESKTOP_SHUTDOWN_CAPTURE_LIMITS.segmentBytes,
								true,
							);
							for (const line of content.split("\n")) {
								const record = projectRecord(line, name);
								if (record) instance.records.push(record);
							}
							if (instance.records.length > DESKTOP_SHUTDOWN_CAPTURE_LIMITS.recordsPerInstance) issue("limit");
							instance.records = instance.records.slice(-DESKTOP_SHUTDOWN_CAPTURE_LIMITS.recordsPerInstance);
						}
					} catch (error) {
						failure(error);
					}
				}
			} catch (error) {
				failure(error);
			}
		} catch (error) {
			failure(error);
		}
		if (proof.instances.length === 0) issue("unavailable");
		check();
		const text = `${JSON.stringify(proof, null, 2)}\n`;
		if (Buffer.byteLength(text) > DESKTOP_SHUTDOWN_CAPTURE_LIMITS.outputBytes) throw new CaptureFailure("limit");
		const temporary = join(artifact, `.shutdown-timeout-${randomUUID()}.tmp`);
		try {
			const file = await open(
				temporary,
				constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
				0o600,
			);
			try {
				check();
				await file.writeFile(text, { encoding: "utf8", signal: controller.signal });
			} finally {
				await file.close();
			}
			check();
			if (!(await lstat(artifact)).isDirectory()) throw new CaptureFailure("outside_fixture");
			check();
			await rename(temporary, join(artifact, "shutdown-timeout.json"));
		} catch {
			issue("write_failed");
		} finally {
			await unlink(temporary).catch(() => undefined);
		}
	};
	let timer: ReturnType<typeof setTimeout> | undefined;
	try {
		await Promise.race([
			work(),
			new Promise<void>((done) => {
				timer = setTimeout(() => {
					controller.abort();
					issue("deadline");
					done();
				}, DESKTOP_SHUTDOWN_CAPTURE_LIMITS.durationMs);
			}),
		]);
	} catch (error) {
		failure(error);
	} finally {
		if (timer) clearTimeout(timer);
		controller.abort();
	}
	return structuredClone(proof);
}
