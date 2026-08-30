import type { ExecFileException } from "node:child_process";
import { execFile } from "node:child_process";
import { open, readdir, readFile, unlink } from "node:fs/promises";
import { join } from "node:path";

import { type EnsurePrivateDirectoryOptions, ensurePrivateDirectory } from "../core/private-directory";
import { mergeProcessEnvironment } from "../core/process-environment.js";
import { terminateProcessForTimeout } from "../core/process-termination.js";
import { resolveWindowsPowerShellPath } from "../core/windows-system-paths.js";
import { getRuntimeHomePath } from "../state";

const MANAGED_PROCESS_REGISTRY_DIRECTORY = "managed-processes";
const MANAGED_PROCESS_RECORD_VERSION = 1;
const PROCESS_IDENTITY_ENVIRONMENT_KEY = "QUARTERDECK_PROCESS_IDENTITY_PIDS";
const WINDOWS_PROCESS_SNAPSHOT_TIMEOUT_MS = 10_000;

const WINDOWS_PROCESS_SNAPSHOT_SCRIPT = [
	"$ErrorActionPreference = 'Stop'",
	`$serializedPids = [Environment]::GetEnvironmentVariable('${PROCESS_IDENTITY_ENVIRONMENT_KEY}', 'Process')`,
	"$requestedPids = if ([string]::IsNullOrWhiteSpace($serializedPids)) { @() } else { @(ConvertFrom-Json -InputObject $serializedPids) }",
	"$requested = @{}",
	"foreach ($requestedPid in $requestedPids) { $requested[[int]$requestedPid] = $true }",
	"$processes = if ($requested.Count -eq 0) { @() } else { $filter = (($requested.Keys | ForEach-Object { 'ProcessId = ' + [int]$_ }) -join ' OR '); @(Get-CimInstance Win32_Process -Filter $filter) }",
	"$rows = @(foreach ($process in $processes) { if ($null -eq $process.CreationDate) { continue }; [pscustomobject]@{ pid = [int]$process.ProcessId; parentPid = [int]$process.ParentProcessId; creationTime = ([datetime]$process.CreationDate).ToUniversalTime().Ticks.ToString([System.Globalization.CultureInfo]::InvariantCulture) } })",
	"ConvertTo-Json -InputObject $rows -Compress",
].join("; ");

const WINDOWS_PROCESS_SNAPSHOT_ENCODED_SCRIPT = Buffer.from(WINDOWS_PROCESS_SNAPSHOT_SCRIPT, "utf16le").toString(
	"base64",
);

export interface ManagedProcessIdentity {
	pid: number;
	creationTime: string;
}

interface WindowsProcessSnapshotIdentity extends ManagedProcessIdentity {
	parentPid: number;
}

interface ManagedProcessOwnershipRecord {
	version: typeof MANAGED_PROCESS_RECORD_VERSION;
	recordId: string;
	registeredAt: string;
	ownerRuntime: ManagedProcessIdentity;
	rootProcess: ManagedProcessIdentity;
}

export interface ManagedProcessOwnershipHandle {
	recordId: string;
	path: string;
}

export interface AbandonedManagedProcess {
	identity: ManagedProcessIdentity;
	records: ManagedProcessOwnershipHandle[];
}

export interface WindowsProcessSnapshotResult {
	ok: boolean;
	stdout: string;
}

export type WindowsProcessSnapshotRunner = (pids?: readonly number[]) => Promise<WindowsProcessSnapshotResult>;

type EnsurePrivateRegistryDirectory = (path: string, options?: EnsurePrivateDirectoryOptions) => Promise<void>;

export interface ManagedProcessOwnershipOptions {
	platform?: NodeJS.Platform;
	stateHome?: string;
	runtimePid?: number;
	runProcessSnapshot?: WindowsProcessSnapshotRunner;
	ensurePrivateRegistryDirectory?: EnsurePrivateRegistryDirectory;
	privateDirectoryOptions?: EnsurePrivateDirectoryOptions;
}

export interface DiscoverAbandonedManagedProcessesOptions extends ManagedProcessOwnershipOptions {
	includeCurrentRuntime?: boolean;
}

export class ManagedProcessOwnershipError extends Error {
	readonly code = "ManagedProcessOwnershipError";

	constructor(message: string) {
		super(message);
		this.name = "ManagedProcessOwnershipError";
	}
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

function isPositiveInteger(value: unknown): value is number {
	return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function readCreationTime(value: unknown): string | null {
	return typeof value === "string" && /^\d+$/u.test(value) ? value : null;
}

function parseIdentity(value: unknown): ManagedProcessIdentity | null {
	if (!isRecord(value) || !isPositiveInteger(value.pid)) return null;
	const creationTime = readCreationTime(value.creationTime);
	return creationTime ? { pid: value.pid, creationTime } : null;
}

function parseOwnershipRecord(value: unknown): ManagedProcessOwnershipRecord | null {
	if (!isRecord(value) || value.version !== MANAGED_PROCESS_RECORD_VERSION) return null;
	if (typeof value.recordId !== "string" || !/^[0-9a-f-]{36}$/iu.test(value.recordId)) return null;
	if (typeof value.registeredAt !== "string" || !Number.isFinite(Date.parse(value.registeredAt))) return null;
	const ownerRuntime = parseIdentity(value.ownerRuntime);
	const rootProcess = parseIdentity(value.rootProcess);
	if (!ownerRuntime || !rootProcess) return null;
	return {
		version: MANAGED_PROCESS_RECORD_VERSION,
		recordId: value.recordId,
		registeredAt: value.registeredAt,
		ownerRuntime,
		rootProcess,
	};
}

function parseWindowsProcessSnapshot(stdout: string): WindowsProcessSnapshotIdentity[] {
	const trimmed = stdout.trim();
	if (!trimmed) return [];
	let parsed: unknown;
	try {
		parsed = JSON.parse(trimmed);
	} catch {
		throw new ManagedProcessOwnershipError("Windows returned an unreadable managed-process identity snapshot.");
	}

	const rows = Array.isArray(parsed) ? parsed : [parsed];
	const identities: WindowsProcessSnapshotIdentity[] = [];
	for (const row of rows) {
		if (!isRecord(row) || !isPositiveInteger(row.pid)) {
			continue;
		}
		const parentPid = row.parentPid;
		if (typeof parentPid !== "number" || !Number.isInteger(parentPid) || parentPid < 0) continue;
		const creationTime = readCreationTime(row.creationTime);
		if (!creationTime) continue;
		identities.push({ pid: row.pid, parentPid, creationTime });
	}
	return identities;
}

function runWindowsProcessSnapshot(pids: readonly number[] = []): Promise<WindowsProcessSnapshotResult> {
	return new Promise((resolve) => {
		let timeout: NodeJS.Timeout | null = null;
		const child = execFile(
			resolveWindowsPowerShellPath(),
			[
				"-NoLogo",
				"-NoProfile",
				"-NonInteractive",
				"-ExecutionPolicy",
				"Bypass",
				"-EncodedCommand",
				WINDOWS_PROCESS_SNAPSHOT_ENCODED_SCRIPT,
			],
			{
				encoding: "utf8",
				env: mergeProcessEnvironment(process.env, {
					[PROCESS_IDENTITY_ENVIRONMENT_KEY]: JSON.stringify(pids),
				}),
				windowsHide: true,
			},
			(error: ExecFileException | null, stdout: string | Buffer) => {
				if (timeout) clearTimeout(timeout);
				resolve({ ok: error === null, stdout: String(stdout ?? "") });
			},
		);
		timeout = setTimeout(() => terminateProcessForTimeout(child), WINDOWS_PROCESS_SNAPSHOT_TIMEOUT_MS);
		timeout.unref();
	});
}

function getRegistryPath(stateHome = getRuntimeHomePath()): string {
	return join(stateHome, MANAGED_PROCESS_REGISTRY_DIRECTORY);
}

async function prepareRegistryDirectory(options: ManagedProcessOwnershipOptions): Promise<string> {
	const registryPath = getRegistryPath(options.stateHome);
	await (options.ensurePrivateRegistryDirectory ?? ensurePrivateDirectory)(registryPath, {
		platform: options.platform ?? process.platform,
		...options.privateDirectoryOptions,
	});
	return registryPath;
}

async function readSnapshot(
	pids: readonly number[] | undefined,
	options: ManagedProcessOwnershipOptions,
): Promise<WindowsProcessSnapshotIdentity[]> {
	const result = await (options.runProcessSnapshot ?? runWindowsProcessSnapshot)(pids);
	if (!result.ok) {
		throw new ManagedProcessOwnershipError("Could not query Windows process creation identities.");
	}
	return parseWindowsProcessSnapshot(result.stdout);
}

function identitiesMatch(left: ManagedProcessIdentity, right: ManagedProcessIdentity | undefined): boolean {
	return left.pid === right?.pid && left.creationTime === right.creationTime;
}

async function writeOwnershipRecordExclusive(path: string, record: ManagedProcessOwnershipRecord): Promise<void> {
	let file: Awaited<ReturnType<typeof open>> | null = null;
	let created = false;
	try {
		file = await open(path, "wx", 0o600);
		created = true;
		await file.writeFile(`${JSON.stringify(record, null, 2)}\n`, "utf8");
		await file.sync();
	} catch (error) {
		if (created) await unlink(path).catch(() => undefined);
		throw error;
	} finally {
		await file?.close().catch(() => undefined);
	}
}

/**
 * Records one exact Windows PTY root before the task launch is handed to the
 * rest of the runtime. A process that already exited needs no durable record.
 */
export async function registerManagedProcessOwnership(
	rootPid: number,
	recordId: string,
	options: ManagedProcessOwnershipOptions = {},
): Promise<ManagedProcessOwnershipHandle | null> {
	if ((options.platform ?? process.platform) !== "win32") return null;
	if (!isPositiveInteger(rootPid) || !/^[0-9a-f-]{36}$/iu.test(recordId)) {
		throw new ManagedProcessOwnershipError("Managed process ownership requires a valid PID and launch ID.");
	}

	const runtimePid = options.runtimePid ?? process.pid;
	const registryPath = await prepareRegistryDirectory(options);
	const identities = await readSnapshot([runtimePid, rootPid], options);
	const byPid = new Map(identities.map((identity) => [identity.pid, identity]));
	const ownerRuntime = byPid.get(runtimePid);
	if (!ownerRuntime) {
		throw new ManagedProcessOwnershipError("Could not verify the Quarterdeck runtime process identity.");
	}
	const rootProcess = byPid.get(rootPid);
	if (!rootProcess) return null;
	if (rootProcess.parentPid !== runtimePid) {
		throw new ManagedProcessOwnershipError(
			"Could not verify that the managed process was launched by the Quarterdeck runtime.",
		);
	}

	const path = join(registryPath, `${recordId}.json`);
	await writeOwnershipRecordExclusive(path, {
		version: MANAGED_PROCESS_RECORD_VERSION,
		recordId,
		registeredAt: new Date().toISOString(),
		ownerRuntime: { pid: ownerRuntime.pid, creationTime: ownerRuntime.creationTime },
		rootProcess: { pid: rootProcess.pid, creationTime: rootProcess.creationTime },
	});
	return { recordId, path };
}

export async function retireManagedProcessOwnership(handle: ManagedProcessOwnershipHandle): Promise<void> {
	await unlink(handle.path).catch((error: NodeJS.ErrnoException) => {
		if (error.code !== "ENOENT") throw error;
	});
}

async function readOwnershipRecords(
	registryPath: string,
): Promise<Array<{ record: ManagedProcessOwnershipRecord; handle: ManagedProcessOwnershipHandle }>> {
	const entries = await readdir(registryPath, { withFileTypes: true });
	const records: Array<{ record: ManagedProcessOwnershipRecord; handle: ManagedProcessOwnershipHandle }> = [];
	for (const entry of entries) {
		if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
		const path = join(registryPath, entry.name);
		let record: ManagedProcessOwnershipRecord | null = null;
		try {
			record = parseOwnershipRecord(JSON.parse(await readFile(path, "utf8")));
		} catch {
			// A crashed exclusive write or malformed record never authorizes a kill.
		}
		if (!record || entry.name !== `${record.recordId}.json`) {
			await unlink(path).catch(() => undefined);
			continue;
		}
		records.push({ record, handle: { recordId: record.recordId, path } });
	}
	return records;
}

/** Returns only roots whose exact owner runtime is gone (or explicitly included). */
export async function discoverAbandonedManagedProcesses(
	options: DiscoverAbandonedManagedProcessesOptions = {},
): Promise<AbandonedManagedProcess[]> {
	if ((options.platform ?? process.platform) !== "win32") return [];
	const registryPath = await prepareRegistryDirectory(options);
	const records = await readOwnershipRecords(registryPath);
	if (records.length === 0) return [];

	const requestedPids = [
		...new Set(records.flatMap(({ record }) => [record.ownerRuntime.pid, record.rootProcess.pid])),
	];
	const identities = await readSnapshot(requestedPids, options);
	const byPid = new Map(identities.map((identity) => [identity.pid, identity]));
	const runtimePid = options.runtimePid ?? process.pid;
	const candidates = new Map<string, AbandonedManagedProcess>();
	for (const { record, handle } of records) {
		const rootIdentity = byPid.get(record.rootProcess.pid);
		if (!identitiesMatch(record.rootProcess, rootIdentity)) {
			await retireManagedProcessOwnership(handle);
			continue;
		}

		const ownerIdentity = byPid.get(record.ownerRuntime.pid);
		const ownerIsLive = identitiesMatch(record.ownerRuntime, ownerIdentity);
		const ownerIsCurrentRuntime = ownerIsLive && record.ownerRuntime.pid === runtimePid;
		if (ownerIsLive && !(ownerIsCurrentRuntime && options.includeCurrentRuntime)) continue;

		const key = `${record.rootProcess.pid}:${record.rootProcess.creationTime}`;
		const existing = candidates.get(key);
		if (existing) {
			existing.records.push(handle);
		} else {
			candidates.set(key, { identity: record.rootProcess, records: [handle] });
		}
	}
	return [...candidates.values()];
}

/** Rechecks creation evidence immediately before a candidate may be signalled. */
export async function verifyAbandonedManagedProcess(
	candidate: AbandonedManagedProcess,
	options: ManagedProcessOwnershipOptions = {},
): Promise<boolean> {
	if ((options.platform ?? process.platform) !== "win32") return false;
	const identities = await readSnapshot([candidate.identity.pid], options);
	return identitiesMatch(candidate.identity, identities[0]);
}

export const _testing = {
	getRegistryPath,
	parseWindowsProcessSnapshot,
	WINDOWS_PROCESS_SNAPSHOT_SCRIPT,
};
