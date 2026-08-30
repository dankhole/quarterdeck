import { access, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type {
	DiagnosticRecordEnvelope,
	DiagnosticSnapshot,
	PublicRuntimeDiagnosticDescriptor,
} from "../../../src/core";
import {
	DiagnosticJournal,
	DiagnosticRecorder,
	DiagnosticSnapshotCoordinator,
	evaluateDiagnosticSnapshot,
	filterDiagnosticFindingsByScope,
	writeDiagnosticBundle,
} from "../../../src/diagnostics";

function descriptor(): PublicRuntimeDiagnosticDescriptor {
	return {
		version: 1,
		runtimeInstanceId: "runtime-test",
		status: "ready",
		pid: process.pid,
		host: "127.0.0.1",
		port: 4242,
		quarterdeckVersion: "1.2.3",
		nodeMajorVersion: 22,
		platform: "mac",
		startedAt: new Date(1_000).toISOString(),
		readyAt: new Date(2_000).toISOString(),
		stoppedAt: null,
		failure: null,
	};
}

function record(
	name: string,
	sequence: number,
	options: {
		timestamp?: number;
		context?: DiagnosticRecordEnvelope["context"];
		payload?: DiagnosticRecordEnvelope["payload"];
	} = {},
): DiagnosticRecordEnvelope {
	return {
		version: 1,
		id: `runtime-test:${sequence}`,
		sequence,
		timestamp: options.timestamp ?? 1_000 + sequence,
		monotonicOffsetMs: sequence,
		runtimeInstanceId: "runtime-test",
		source: "runtime",
		kind: "event",
		level: "warn",
		name,
		context: options.context ?? {},
		payload: options.payload ?? {},
	};
}

describe("diagnostic snapshots, doctor, and bundles", () => {
	let directory: string;

	beforeEach(async () => {
		directory = await mkdtemp(join(tmpdir(), "quarterdeck-diagnostics-bundle-"));
	});

	afterEach(async () => {
		await rm(directory, { recursive: true, force: true });
	});

	it("captures providers independently with timeouts, failures, and redaction", async () => {
		const coordinator = new DiagnosticSnapshotCoordinator("runtime-test", { stateHome: "/private/state" });
		coordinator.register({
			name: "healthy",
			capture: () => ({ statePath: "/private/state/projects/p1", prompt: "private" }),
		});
		coordinator.register({ name: "failed", capture: () => Promise.reject(new Error("failure at /private/state")) });
		coordinator.register({
			name: "slow",
			timeoutMs: 5,
			capture: async () => await new Promise((resolve) => setTimeout(resolve, 30)),
		});

		const snapshot = await coordinator.capture(["healthy", "failed", "slow", "missing"], {
			projectId: "p1",
			taskId: "t1",
		});
		expect(snapshot.scope).toEqual({ projectId: "p1", taskId: "t1" });
		expect(snapshot.providers.map((provider) => [provider.name, provider.status])).toEqual([
			["healthy", "completed"],
			["failed", "failed"],
			["slow", "timed_out"],
			["missing", "unavailable"],
		]);
		expect(JSON.stringify(snapshot.providers[0]?.data)).not.toContain("/private/state");
		expect(JSON.stringify(snapshot.providers[0]?.data)).not.toContain("private");
		expect(snapshot.providers[1]?.error).toBe("Error");
		expect(JSON.stringify(snapshot.providers[1])).not.toContain("/private/state");
	});

	it("reports a crash-surviving terminal runtime failure without a live provider", () => {
		const snapshot: DiagnosticSnapshot = {
			version: 1,
			runtimeInstanceId: "runtime-test",
			capturedAt: 2_000,
			providers: [],
		};
		const runtimeFailure = record("terminal.runtime_dependency_missing", 1, {
			payload: { issue: "native_module_missing", platform: "darwin", arch: "arm64" },
		});

		expect(evaluateDiagnosticSnapshot(snapshot, [runtimeFailure])).toEqual([
			expect.objectContaining({
				code: "TERMINAL_RUNTIME_DEPENDENCY_MISSING",
				evidenceRecordIds: [runtimeFailure.id],
			}),
		]);
	});

	it("reports unsupported Pi compatibility, missing extension assets, and unsafe recovery identity", () => {
		const snapshot: DiagnosticSnapshot = {
			version: 1,
			runtimeInstanceId: "runtime-test",
			capturedAt: 2_000,
			providers: [
				{
					name: "pi_support",
					status: "completed",
					durationMs: 1,
					data: {
						supportedVersion: "0.84.3",
						detectedVersion: "0.85.0",
						installed: false,
						reason: "unsupported_version",
						extensionAvailable: false,
					},
				},
				{
					name: "projects",
					status: "completed",
					durationMs: 1,
					data: {
						sessions: [
							{
								projectId: "p1",
								taskId: "pi-task",
								agentId: "pi",
								startupRecoveryRequired: true,
								hasResumeSessionId: false,
							},
						],
					},
				},
			],
		};

		expect(new Set(evaluateDiagnosticSnapshot(snapshot, []).map((finding) => finding.code))).toEqual(
			new Set(["PI_LIFECYCLE_EXTENSION_MISSING", "PI_VERSION_UNSUPPORTED", "PI_RECOVERY_SESSION_ID_MISSING"]),
		);
	});

	it("does not report optional Pi support failures when no Pi task exists", () => {
		const snapshot: DiagnosticSnapshot = {
			version: 1,
			runtimeInstanceId: "runtime-test",
			capturedAt: 2_000,
			providers: [
				{
					name: "pi_support",
					status: "completed",
					durationMs: 1,
					data: {
						supportedVersion: "0.84.3",
						installed: false,
						reason: "missing",
						extensionAvailable: false,
					},
				},
				{
					name: "projects",
					status: "completed",
					durationMs: 1,
					data: {
						sessions: [{ projectId: "p1", taskId: "codex-task", agentId: "codex" }],
					},
				},
			],
		};

		expect(evaluateDiagnosticSnapshot(snapshot, []).map((finding) => finding.code)).not.toEqual(
			expect.arrayContaining(["PI_LIFECYCLE_EXTENSION_MISSING", "PI_VERSION_UNSUPPORTED", "PI_BINARY_MISSING"]),
		);
	});

	it("removes findings explicitly attributed outside the requested scope", () => {
		const finding = (projectId: string, taskId: string) => ({
			code: `TEST_${projectId}_${taskId}`,
			severity: "warn" as const,
			summary: "summary",
			explanation: "explanation",
			context: { projectId, taskId },
			evidenceRecordIds: [],
			observedAt: 1,
		});
		const globalFinding = { ...finding("p1", "t1"), code: "GLOBAL", context: {} };

		expect(
			filterDiagnosticFindingsByScope(
				[finding("p1", "t1"), finding("p1", "t2"), finding("p2", "t1"), globalFinding],
				{ projectId: "p1", taskId: "t1" },
			).map((entry) => entry.code),
		).toEqual(["TEST_p1_t1", "GLOBAL"]);
	});

	it("reports point-in-time lifecycle, transport, provider, and recorder findings without mutation", () => {
		const now = Date.now();
		const snapshot: DiagnosticSnapshot = {
			version: 1,
			runtimeInstanceId: "runtime-test",
			capturedAt: now,
			providers: [
				{
					name: "runtime",
					status: "completed",
					durationMs: 1,
					data: {
						journalHealthy: false,
						droppedRecords: 3,
						descriptorPersistence: { persistent: false },
					},
				},
				{
					name: "projects",
					status: "completed",
					durationMs: 1,
					data: {
						managedProjects: [{ projectId: "p2", hasTerminalManager: false }],
						sessions: [
							{
								projectId: "p1",
								taskId: "t1",
								state: "awaiting_review",
								reviewReason: "error",
								pid: 999,
								pidAlive: false,
								pendingSessionStart: true,
								pendingSince: now - 60_000,
								hasLaunchPath: false,
							},
							{
								projectId: "p1",
								taskId: "t3",
								state: "running",
								pid: null,
								hasActiveProcess: false,
								pendingSessionStart: false,
								exiting: false,
							},
							{
								projectId: "p1",
								taskId: "t4",
								hasSummary: false,
								hasActiveProcess: true,
								mirror: {},
							},
						],
					},
				},
				{
					name: "terminal_runtime",
					status: "completed",
					durationMs: 1,
					data: {
						available: false,
						issue: "spawn_helper_missing",
						platform: "darwin",
						arch: "arm64",
						nativeModuleAvailable: true,
						spawnHelperRequired: true,
						spawnHelperAvailable: false,
					},
				},
				{
					name: "hook_outbox",
					status: "completed",
					durationMs: 1,
					data: { pendingRecords: 4, oldestPendingAgeMs: 20_000, lastDeferred: 3 },
				},
				{
					name: "terminal_transport",
					status: "completed",
					durationMs: 1,
					data: {
						viewers: [
							{
								projectId: "p1",
								taskId: "t1",
								ioConnected: false,
								controlConnected: true,
								backpressured: true,
								lastProtocolActivityAt: now - 20_000,
							},
							{
								projectId: "p1",
								taskId: "t2",
								ioConnected: true,
								controlConnected: true,
								restoreComplete: false,
								restoreStartedAt: now - 20_000,
							},
						],
					},
				},
				{
					name: "project_metadata",
					status: "completed",
					durationMs: 1,
					data: {
						projects: [
							{
								projectId: "p1",
								remoteFetch: { fetchInFlight: true, lastStartedAt: now - 70_000 },
							},
						],
					},
				},
				{
					name: "runtime_stream",
					status: "completed",
					durationMs: 1,
					data: { batcher: { diagnosticRecords: { droppedRecords: 2 } } },
				},
				{
					name: "project_state",
					status: "completed",
					durationMs: 1,
					data: {
						projects: [
							{
								projectId: "p1",
								sessionColumnDivergences: [
									{
										taskId: "t5",
										actualColumnId: "review",
										expectedColumnId: "in_progress",
									},
								],
							},
						],
					},
				},
				{
					name: "browser",
					status: "completed",
					durationMs: 1,
					data: {
						clients: [{ clientId: "c1", terminal: { dom: { xtermElementCount: 9 } } }],
					},
				},
				{ name: "blocked", status: "timed_out", durationMs: 2_000, error: "timeout" },
			],
		};
		const findings = evaluateDiagnosticSnapshot(snapshot, [
			record("diagnostics.records_dropped", 1),
			record("session.startup_recovery_completed", 2, {
				context: { projectId: "p1", taskId: "t1" },
				payload: { status: "exhausted", attempts: 2, reason: "timeout" },
			}),
			record("project.board_save_conflict", 3, { timestamp: now - 1_000, context: { projectId: "p1" } }),
			record("project.state_load_failed", 4, { timestamp: now - 1_000, context: { projectId: "p2" } }),
			...Array.from({ length: 5 }, (_, index) =>
				record("browser.runtime_stream_reconnecting", 5 + index, { timestamp: now - index * 1_000 }),
			),
		]);
		expect(new Set(findings.map((finding) => finding.code))).toEqual(
			new Set([
				"DIAGNOSTIC_JOURNAL_DEGRADED",
				"DIAGNOSTIC_RECORDS_DROPPED",
				"DIAGNOSTIC_STREAM_DELIVERIES_DROPPED",
				"RUNTIME_DESCRIPTOR_PERSISTENCE_DEGRADED",
				"STARTUP_SESSION_RECOVERY_EXHAUSTED",
				"SESSION_PID_NOT_ALIVE",
				"SESSION_START_PENDING_TOO_LONG",
				"SESSION_LAUNCH_PATH_MISSING",
				"SESSION_PROCESS_ENTRY_MISSING",
				"TERMINAL_PROCESS_WITHOUT_SESSION_SUMMARY",
				"PROJECT_MANAGER_MISSING",
				"HOOK_OUTBOX_DELIVERY_OVERDUE",
				"HOOK_REPLAY_REPEATEDLY_DEFERRED",
				"TERMINAL_CONTROL_WITHOUT_IO",
				"TERMINAL_RESTORE_HANDSHAKE_STALLED",
				"TERMINAL_BACKPRESSURE_STUCK",
				"TERMINAL_DOM_INSTANCE_CEILING_EXCEEDED",
				"METADATA_OPERATION_OVERDUE",
				"BOARD_REVISION_CONFLICT_RECENT",
				"BOARD_SESSION_PROJECTION_DIVERGED",
				"PROJECT_STATE_LOAD_FAILED",
				"RUNTIME_STREAM_RECONNECT_LOOP",
				"DIAGNOSTIC_PROVIDER_TIMED_OUT",
				"TERMINAL_RUNTIME_DEPENDENCY_MISSING",
			]),
		);
	});

	it("reports only the latest unresolved startup recovery exhaustion per task", () => {
		const snapshot: DiagnosticSnapshot = {
			version: 1,
			runtimeInstanceId: "runtime-test",
			capturedAt: 5_000,
			providers: [
				{
					name: "projects",
					status: "completed",
					durationMs: 1,
					data: {
						sessions: [
							{
								projectId: "p1",
								taskId: "unresolved",
								state: "awaiting_review",
								reviewReason: "error",
							},
							{
								projectId: "p1",
								taskId: "manually-restarted",
								state: "running",
								reviewReason: null,
							},
						],
					},
				},
			],
		};
		const findings = evaluateDiagnosticSnapshot(snapshot, [
			record("session.startup_recovery_completed", 1, {
				timestamp: 1_000,
				context: { projectId: "p1", taskId: "unresolved" },
				payload: { status: "exhausted" },
			}),
			record("session.startup_recovery_completed", 2, {
				timestamp: 2_000,
				context: { projectId: "p1", taskId: "unresolved" },
				payload: { status: "exhausted" },
			}),
			record("session.startup_recovery_completed", 3, {
				timestamp: 3_000,
				context: { projectId: "p1", taskId: "manually-restarted" },
				payload: { status: "exhausted" },
			}),
			record("session.startup_recovery_completed", 4, {
				timestamp: 4_000,
				context: { projectId: "p1", taskId: "later-recovered" },
				payload: { status: "exhausted" },
			}),
			record("session.startup_recovery_completed", 5, {
				timestamp: 5_000,
				context: { projectId: "p1", taskId: "later-recovered" },
				payload: { status: "ready" },
			}),
		]);

		const recoveryFindings = findings.filter((finding) => finding.code === "STARTUP_SESSION_RECOVERY_EXHAUSTED");
		expect(recoveryFindings).toHaveLength(1);
		expect(recoveryFindings[0]).toMatchObject({
			context: { projectId: "p1", taskId: "unresolved" },
			evidenceRecordIds: ["runtime-test:2"],
		});
	});

	it("retains the latest exhausted startup recovery evidence when current session state is unavailable", () => {
		const snapshot: DiagnosticSnapshot = {
			version: 1,
			runtimeInstanceId: "runtime-test",
			capturedAt: 3_000,
			providers: [{ name: "projects", status: "unavailable", durationMs: 0 }],
		};
		const findings = evaluateDiagnosticSnapshot(snapshot, [
			record("session.startup_recovery_completed", 1, {
				timestamp: 1_000,
				context: { projectId: "p1", taskId: "t1" },
				payload: { status: "exhausted" },
			}),
			record("session.startup_recovery_completed", 2, {
				timestamp: 2_000,
				context: { projectId: "p1", taskId: "t1" },
				payload: { status: "exhausted" },
			}),
		]);

		expect(findings).toEqual([
			expect.objectContaining({
				code: "STARTUP_SESSION_RECOVERY_EXHAUSTED",
				evidenceRecordIds: ["runtime-test:2"],
			}),
		]);
	});

	it("reports offline runtime evidence as partial rather than healthy", () => {
		const findings = evaluateDiagnosticSnapshot(
			{
				version: 1,
				runtimeInstanceId: "runtime-test",
				capturedAt: Date.now(),
				providers: [
					{
						name: "runtime",
						status: "unavailable",
						durationMs: 0,
						error: "Runtime is not reachable.",
					},
				],
			},
			[],
		);

		expect(findings.map((finding) => finding.code)).toEqual(["RUNTIME_DESCRIPTOR_UNREACHABLE"]);
	});

	it("writes an atomic checksummed bundle with stable evidence files", async () => {
		const output = join(directory, "capture");
		const snapshot: DiagnosticSnapshot = {
			version: 1,
			runtimeInstanceId: "runtime-test",
			capturedAt: 2_000,
			providers: [{ name: "runtime", status: "completed", durationMs: 1, data: { ok: true } }],
		};
		const result = await writeDiagnosticBundle({
			quarterdeckVersion: "1.2.3",
			descriptor: descriptor(),
			records: [record("second", 2), record("first", 1)],
			snapshot,
			findings: [],
			health: null,
			warnings: ["one warning", "one warning"],
			outputDirectory: output,
		});

		expect(result.path).toBe(output);
		expect(result.manifest.status).toBe("partial");
		expect(result.manifest.warnings).toEqual(["one warning"]);
		expect(result.manifest.files.length).toBeGreaterThan(3);
		await access(join(output, "manifest.json"));
		await access(join(output, "records.jsonl"));
		const records = (await readFile(join(output, "records.jsonl"), "utf8")).trim().split("\n");
		expect(records.map((line) => JSON.parse(line).sequence)).toEqual([1, 2]);
		const siblings = await readdir(directory);
		expect(siblings.some((name) => name.endsWith(".tmp"))).toBe(false);
	});

	it("uses portable filenames for provider names reserved by Windows", async () => {
		const output = join(directory, "portable-provider-capture");
		const snapshot: DiagnosticSnapshot = {
			version: 1,
			runtimeInstanceId: "runtime-test",
			capturedAt: 2_000,
			providers: [{ name: "con", status: "completed", durationMs: 1, data: { ok: true } }],
		};

		await writeDiagnosticBundle({
			quarterdeckVersion: "1.2.3",
			descriptor: descriptor(),
			records: [],
			snapshot,
			findings: [],
			health: null,
			outputDirectory: output,
		});

		expect(await readFile(join(output, "runtime", "providers", "provider-con.json"), "utf8")).toContain('"ok": true');
	});

	it("keeps privacy sentinels out of a default canonical bundle", async () => {
		const output = join(directory, "privacy-capture");
		const journal = new DiagnosticJournal(join(directory, "privacy-journal"), {
			flushRecordCount: 100,
			flushIntervalMs: 60_000,
		});
		const recorder = new DiagnosticRecorder({ runtimeInstanceId: "runtime-test", journal });
		const retained = recorder.recordEvent(
			"privacy.sentinel",
			{
				authorization: "Bearer sentinel-secret-DO-NOT-LEAK",
				prompt: "sentinel private prompt",
				workingDirectory: "/private/diagnostics-sentinel/repository",
				message: "token sk-abcdefghijklmnopqrstuvwxyz",
			},
			{},
			{ level: "warn", essential: true },
		);
		const coordinator = new DiagnosticSnapshotCoordinator("runtime-test");
		coordinator.register({
			name: "privacy",
			capture: () => ({
				apiKey: "sentinel-api-key-DO-NOT-LEAK",
				transcript: "sentinel private transcript",
				projectPath: "/private/diagnostics-sentinel/repository",
			}),
		});
		const snapshot = await coordinator.capture();
		await recorder.close();

		await writeDiagnosticBundle({
			quarterdeckVersion: "1.2.3",
			descriptor: descriptor(),
			records: retained ? [retained] : [],
			snapshot,
			findings: [],
			health: recorder.getHealth(),
			outputDirectory: output,
		});

		const serialized = [
			await readFile(join(output, "records.jsonl"), "utf8"),
			await readFile(join(output, "runtime", "providers", "privacy.json"), "utf8"),
		].join("\n");
		expect(serialized).not.toContain("DO-NOT-LEAK");
		expect(serialized).not.toContain("sentinel private");
		expect(serialized).not.toContain("/private/diagnostics-sentinel");
		expect(serialized).not.toContain("abcdefghijklmnopqrstuvwxyz");
	});

	it("indexes copied lab evidence in the canonical manifest", async () => {
		const output = join(directory, "lab-capture");
		const evidence = join(directory, "evidence");
		await mkdir(evidence);
		await writeFile(join(evidence, "browser-actions.jsonl"), '{"stage":"completed"}\n', "utf8");
		const snapshot: DiagnosticSnapshot = {
			version: 1,
			runtimeInstanceId: "runtime-test",
			capturedAt: 2_000,
			providers: [],
		};
		const result = await writeDiagnosticBundle({
			quarterdeckVersion: "1.2.3",
			descriptor: descriptor(),
			records: [],
			snapshot,
			findings: [],
			health: null,
			tier: "agent-lab",
			outputDirectory: output,
			additionalEvidence: [{ sourcePath: evidence, bundlePath: "lab", required: true }],
		});

		expect(result.manifest.files.some((file) => file.path === "lab/browser-actions.jsonl")).toBe(true);
		expect(await readFile(join(output, "lab", "browser-actions.jsonl"), "utf8")).toContain("completed");
	});

	it("rejects evidence paths outside the isolated lab namespace", async () => {
		const evidence = join(directory, "evidence.txt");
		await writeFile(evidence, "synthetic", "utf8");
		await expect(
			writeDiagnosticBundle({
				quarterdeckVersion: "1.2.3",
				descriptor: descriptor(),
				records: [],
				snapshot: { version: 1, runtimeInstanceId: "runtime-test", capturedAt: 2_000, providers: [] },
				findings: [],
				health: null,
				tier: "agent-lab",
				outputDirectory: join(directory, "invalid-evidence-capture"),
				additionalEvidence: [{ sourcePath: evidence, bundlePath: "runtime/descriptor.json" }],
			}),
		).rejects.toThrow("must be stored under lab/");
	});

	it("rejects lab evidence on production capture tiers", async () => {
		const evidence = join(directory, "evidence.txt");
		await writeFile(evidence, "synthetic", "utf8");
		await expect(
			writeDiagnosticBundle({
				quarterdeckVersion: "1.2.3",
				descriptor: descriptor(),
				records: [],
				snapshot: { version: 1, runtimeInstanceId: "runtime-test", capturedAt: 2_000, providers: [] },
				findings: [],
				health: null,
				tier: "flight",
				outputDirectory: join(directory, "invalid-production-evidence-capture"),
				additionalEvidence: [{ sourcePath: evidence, bundlePath: "lab/evidence.txt" }],
			}),
		).rejects.toThrow("restricted to the isolated agent-lab tier");
	});

	it("rejects content-bearing flags on production capture tiers", async () => {
		await expect(
			writeDiagnosticBundle({
				quarterdeckVersion: "1.2.3",
				descriptor: descriptor(),
				records: [],
				snapshot: { version: 1, runtimeInstanceId: "runtime-test", capturedAt: 2_000, providers: [] },
				findings: [],
				health: null,
				tier: "deep",
				contentFlags: { includeTerminal: true },
				outputDirectory: join(directory, "invalid-production-content-capture"),
			}),
		).rejects.toThrow("restricted to the isolated agent-lab tier");
	});
});
