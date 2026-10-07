// State backup system for Quarterdeck.
// Snapshots critical state files to ~/.quarterdeck-backups/ so they survive
// a wipe of ~/.quarterdeck/. Supports manual and periodic backups with
// automatic pruning of old snapshots.
//
// Backup layout:
//   ~/.quarterdeck-backups/
//     {ISO-timestamp}/
//       manifest.json
//       config.json
//       projects/
//         index.json
//         {projectId}/
//           board.json, sessions.json, meta.json, pinned-branches.json,
//           lifecycle-operations.json, execution-ownership.json

import { mkdir, readdir, readFile, rm, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, isAbsolute, join, resolve } from "node:path";
import { createTaggedLogger, normalizeDiagnosticErrorClass } from "../core";
import { isNodeError } from "../fs";
import { lockedFileSystem } from "../fs/locked-file-system";
import { removeDirectoryWithRetries } from "../fs/remove-path";
import { getProjectRelocationJournalPath, readProjectRelocationJournal } from "./project-relocation-journal";
import { withProjectStateLock } from "./project-state-transaction";
import {
	BOARD_FILENAME,
	EXECUTION_OWNERSHIP_FILENAME,
	getProjectBoardPath,
	getProjectDirectoryPath,
	getProjectExecutionOwnershipPath,
	getProjectIndexLockRequest,
	getProjectLifecycleOperationsPath,
	getProjectMetaPath,
	getProjectPinnedBranchesPath,
	getProjectSessionsPath,
	getProjectsRootPath,
	getRuntimeHomePath,
	LIFECYCLE_OPERATIONS_FILENAME,
	META_FILENAME,
	PINNED_BRANCHES_FILENAME,
	SESSIONS_FILENAME,
} from "./project-state-utils";
import { assertRuntimeWriteAdmission } from "./runtime-write-admission.js";

const DEFAULT_BACKUP_HOME = join(homedir(), ".quarterdeck-backups");
const DEFAULT_MAX_BACKUPS = 10;
const PROJECT_STATE_FILENAMES = [
	BOARD_FILENAME,
	SESSIONS_FILENAME,
	META_FILENAME,
	PINNED_BRANCHES_FILENAME,
	LIFECYCLE_OPERATIONS_FILENAME,
	EXECUTION_OWNERSHIP_FILENAME,
];
const COORDINATION_JOURNAL_FILENAMES = [LIFECYCLE_OPERATIONS_FILENAME, EXECUTION_OWNERSHIP_FILENAME];
const backupLog = createTaggedLogger("state-backup");

export interface BackupManifest {
	timestamp: number;
	version: number;
	projectIds: string[];
	trigger: "startup" | "periodic" | "manual";
}

export interface BackupListEntry {
	name: string;
	path: string;
	manifest: BackupManifest;
}

// --- Path helpers ---

export function getBackupHomePath(): string {
	const override = process.env.QUARTERDECK_BACKUP_HOME;
	if (override) {
		return resolve(override);
	}
	return DEFAULT_BACKUP_HOME;
}

function toBackupDirectoryName(date: Date): string {
	return date.toISOString().replace(/[:.]/g, "-");
}

// --- File helpers ---

async function fileExists(path: string): Promise<boolean> {
	try {
		await stat(path);
		return true;
	} catch {
		return false;
	}
}

async function copyFileIfExists(src: string, dest: string): Promise<void> {
	try {
		assertRuntimeWriteAdmission(getRuntimeHomePath());
		const content = await readFile(src, "utf8");
		assertRuntimeWriteAdmission(getRuntimeHomePath());
		await lockedFileSystem.writeTextFileAtomic(dest, content, {
			lock: null,
			admissionPaths: [getRuntimeHomePath()],
		});
	} catch (error) {
		if (!isNodeError(error, "ENOENT")) {
			throw error;
		}
	}
}

async function restoreCoordinationJournal(src: string, dest: string): Promise<void> {
	if (await fileExists(src)) {
		await copyFileIfExists(src, dest);
		return;
	}
	// Restoring a snapshot without a coordination journal must not retain
	// operations or process ownership created after that snapshot.
	assertRuntimeWriteAdmission(dest);
	await rm(dest, { force: true });
}

async function readJsonFileSafe(path: string): Promise<unknown | null> {
	try {
		const raw = await readFile(path, "utf8");
		return JSON.parse(raw) as unknown;
	} catch {
		return null;
	}
}

async function discoverProjectIds(indexPath: string): Promise<string[]> {
	const raw = await readJsonFileSafe(indexPath);
	if (!raw || typeof raw !== "object") {
		return [];
	}
	const index = raw as { entries?: Record<string, unknown> };
	if (!index.entries || typeof index.entries !== "object") {
		return [];
	}
	return Object.keys(index.entries);
}

async function resolveBackupPath(backupPathOrName: string): Promise<string> {
	if (isAbsolute(backupPathOrName)) {
		return backupPathOrName;
	}
	const backupDir = join(getBackupHomePath(), backupPathOrName);
	if (await fileExists(join(backupDir, "manifest.json"))) {
		return backupDir;
	}
	throw new Error(`Backup not found: ${backupPathOrName}`);
}

// --- Core operations ---

export interface CreateBackupOptions {
	trigger?: BackupManifest["trigger"];
	maxBackups?: number;
}

/**
 * Create a state backup snapshot. Returns the backup directory path,
 * or null if there was nothing to back up.
 */
export function createBackup(options: CreateBackupOptions = {}): Promise<string | null> {
	// Location changes commit board/session paths before their indexed path. Keep
	// the index fixed until all project snapshots have rejected pending moves.
	return trackBackupOperation(
		lockedFileSystem.withLock(getProjectIndexLockRequest(), async () => await createBackupUnderIndexLock(options)),
	);
}

const pendingBackupOperations = new Set<Promise<unknown>>();

function trackBackupOperation<T>(operation: Promise<T>): Promise<T> {
	pendingBackupOperations.add(operation);
	void operation.then(
		() => pendingBackupOperations.delete(operation),
		() => pendingBackupOperations.delete(operation),
	);
	return operation;
}

/** Stop periodic admission first, then retain ownership until all started backup I/O settles. */
export async function waitForPendingBackups(): Promise<void> {
	while (pendingBackupOperations.size > 0) {
		await Promise.allSettled(Array.from(pendingBackupOperations));
	}
}

async function createBackupUnderIndexLock(options: CreateBackupOptions): Promise<string | null> {
	const trigger = options.trigger ?? "manual";
	const maxBackups = options.maxBackups ?? DEFAULT_MAX_BACKUPS;

	const runtimeHome = getRuntimeHomePath();
	assertRuntimeWriteAdmission(runtimeHome);
	const globalConfigPath = join(runtimeHome, "config.json");
	const projectsRoot = getProjectsRootPath();
	const indexPath = join(projectsRoot, "index.json");

	const indexExists = await fileExists(indexPath);
	const configExists = await fileExists(globalConfigPath);
	if (!indexExists && !configExists) {
		return null;
	}

	const projectIds = await discoverProjectIds(indexPath);
	const now = new Date();
	const backupDir = join(getBackupHomePath(), toBackupDirectoryName(now));
	assertRuntimeWriteAdmission(runtimeHome);
	await mkdir(backupDir, { recursive: true });

	try {
		await copyFileIfExists(globalConfigPath, join(backupDir, "config.json"));

		const backupProjectsDir = join(backupDir, "projects");
		if (indexExists) {
			assertRuntimeWriteAdmission(runtimeHome);
			await mkdir(backupProjectsDir, { recursive: true });
			await copyFileIfExists(indexPath, join(backupProjectsDir, "index.json"));
		}

		for (const projectId of projectIds) {
			const wsBackupDir = join(backupProjectsDir, projectId);
			assertRuntimeWriteAdmission(runtimeHome);
			await mkdir(wsBackupDir, { recursive: true });
			await withProjectStateLock(projectId, async () => {
				if (await readProjectRelocationJournal(projectId)) {
					throw new Error(
						`Project "${projectId}" has a folder relocation awaiting recovery. Finish it before backing up.`,
					);
				}
				await copyFileIfExists(getProjectBoardPath(projectId), join(wsBackupDir, BOARD_FILENAME));
				await copyFileIfExists(getProjectSessionsPath(projectId), join(wsBackupDir, SESSIONS_FILENAME));
				await copyFileIfExists(getProjectMetaPath(projectId), join(wsBackupDir, META_FILENAME));
				await copyFileIfExists(
					getProjectPinnedBranchesPath(projectId),
					join(wsBackupDir, PINNED_BRANCHES_FILENAME),
				);
				await copyFileIfExists(
					getProjectLifecycleOperationsPath(projectId),
					join(wsBackupDir, LIFECYCLE_OPERATIONS_FILENAME),
				);
				await copyFileIfExists(
					getProjectExecutionOwnershipPath(projectId),
					join(wsBackupDir, EXECUTION_OWNERSHIP_FILENAME),
				);
			});
		}

		// Manifest written last — acts as the commit signal.
		const manifest: BackupManifest = {
			timestamp: now.getTime(),
			version: 1,
			projectIds,
			trigger,
		};
		assertRuntimeWriteAdmission(runtimeHome);
		await lockedFileSystem.writeJsonFileAtomic(join(backupDir, "manifest.json"), manifest, {
			lock: null,
			admissionPaths: [runtimeHome],
		});
	} catch (error) {
		// Clean up incomplete backup directory so it doesn't accumulate as junk.
		try {
			assertRuntimeWriteAdmission(runtimeHome);
			await removeDirectoryWithRetries(backupDir);
		} catch {
			/* A lost owner leaves its partial backup for later maintenance. */
		}
		throw error;
	}

	await pruneBackups(maxBackups);
	return backupDir;
}

/** List all valid backups, newest-first. */
export async function listBackups(): Promise<BackupListEntry[]> {
	const backupHome = getBackupHomePath();
	let entries: string[];
	try {
		entries = await readdir(backupHome);
	} catch (error) {
		if (isNodeError(error, "ENOENT")) {
			return [];
		}
		throw error;
	}

	const backups: BackupListEntry[] = [];
	for (const name of entries) {
		const backupDir = join(backupHome, name);
		const manifest = (await readJsonFileSafe(join(backupDir, "manifest.json"))) as BackupManifest | null;
		if (!manifest || typeof manifest.timestamp !== "number") {
			continue;
		}
		backups.push({ name, path: backupDir, manifest });
	}

	backups.sort((a, b) => b.manifest.timestamp - a.manifest.timestamp);
	return backups;
}

/**
 * Restore state from a backup. Overwrites current state files.
 * The caller should ensure the Quarterdeck server is not running.
 */
export async function restoreBackup(backupPathOrName: string): Promise<BackupManifest> {
	assertRuntimeWriteAdmission(getRuntimeHomePath());
	const backupDir = await resolveBackupPath(backupPathOrName);
	const manifest = (await readJsonFileSafe(join(backupDir, "manifest.json"))) as BackupManifest | null;
	if (!manifest) {
		throw new Error(`No valid manifest found in backup: ${backupDir}`);
	}

	const runtimeHome = getRuntimeHomePath();
	const projectsRoot = getProjectsRootPath();
	const currentProjectIds = await discoverProjectIds(join(projectsRoot, "index.json"));
	for (const projectId of new Set([...currentProjectIds, ...manifest.projectIds])) {
		if (await readProjectRelocationJournal(projectId)) {
			throw new Error(
				`Project "${projectId}" has a folder relocation awaiting recovery. Finish it before restoring.`,
			);
		}
		const journalFilename = basename(getProjectRelocationJournalPath(projectId));
		if (await fileExists(join(backupDir, "projects", projectId, journalFilename))) {
			throw new Error("This backup contains an unfinished folder relocation and cannot be restored safely.");
		}
	}

	const backupConfigPath = join(backupDir, "config.json");
	if (await fileExists(backupConfigPath)) {
		assertRuntimeWriteAdmission(runtimeHome);
		await mkdir(runtimeHome, { recursive: true });
		await copyFileIfExists(backupConfigPath, join(runtimeHome, "config.json"));
	}

	const backupIndexPath = join(backupDir, "projects", "index.json");
	if (await fileExists(backupIndexPath)) {
		assertRuntimeWriteAdmission(runtimeHome);
		await mkdir(projectsRoot, { recursive: true });
		await copyFileIfExists(backupIndexPath, join(projectsRoot, "index.json"));
	}

	for (const projectId of manifest.projectIds) {
		const wsBackupDir = join(backupDir, "projects", projectId);
		const wsDir = getProjectDirectoryPath(projectId);
		assertRuntimeWriteAdmission(wsDir);
		await mkdir(wsDir, { recursive: true });
		// Recover and remove any pending commit before replacing it with the backup.
		await withProjectStateLock(projectId, async () => {
			for (const filename of PROJECT_STATE_FILENAMES) {
				if (COORDINATION_JOURNAL_FILENAMES.includes(filename)) {
					await restoreCoordinationJournal(join(wsBackupDir, filename), join(wsDir, filename));
				} else {
					await copyFileIfExists(join(wsBackupDir, filename), join(wsDir, filename));
				}
			}
		});
	}

	return manifest;
}

/** Remove backups older than the most recent `keep` backups. */
export async function pruneBackups(keep: number = DEFAULT_MAX_BACKUPS): Promise<number> {
	const backups = await listBackups();
	if (backups.length <= keep) {
		return 0;
	}

	const toRemove = backups.slice(keep);
	let removed = 0;
	for (const backup of toRemove) {
		try {
			assertRuntimeWriteAdmission(getRuntimeHomePath());
			await removeDirectoryWithRetries(backup.path);
			removed += 1;
		} catch {
			// Best-effort pruning.
		}
	}
	return removed;
}

// --- Periodic backup timer ---

let periodicTimer: ReturnType<typeof setInterval> | null = null;
let lastFingerprint: string | null = null;
let periodicGeneration = 0;

/** Lightweight change detection via mtime + size — avoids reading file contents every tick. */
async function computeStateFingerprint(): Promise<string> {
	const parts: string[] = [];
	const runtimeHome = getRuntimeHomePath();
	const indexPath = join(getProjectsRootPath(), "index.json");

	for (const path of [join(runtimeHome, "config.json"), indexPath]) {
		try {
			const info = await stat(path);
			parts.push(`${path}:${info.mtimeMs}:${info.size}`);
		} catch {
			parts.push(`${path}:missing`);
		}
	}

	for (const projectId of await discoverProjectIds(indexPath)) {
		await withProjectStateLock(projectId, async () => {
			for (const getter of [
				getProjectBoardPath,
				getProjectSessionsPath,
				getProjectMetaPath,
				getProjectLifecycleOperationsPath,
				getProjectExecutionOwnershipPath,
			]) {
				const path = getter(projectId);
				try {
					const info = await stat(path);
					parts.push(`${path}:${info.mtimeMs}:${info.size}`);
				} catch {
					parts.push(`${path}:missing`);
				}
			}
		});
	}

	return parts.join("|");
}

export function startPeriodicBackups(intervalMinutes: number): void {
	stopPeriodicBackups();
	if (intervalMinutes <= 0) {
		return;
	}
	const generation = periodicGeneration;

	// Capture initial fingerprint so first tick can compare.
	trackBackupOperation(computeStateFingerprint())
		.then((fp) => {
			if (generation === periodicGeneration) lastFingerprint = fp;
		})
		.catch((error: unknown) => {
			backupLog.warn("failed to establish periodic backup fingerprint", {
				errorClass: error instanceof Error ? normalizeDiagnosticErrorClass(error.name) : "UnknownError",
			});
		});

	periodicTimer = setInterval(
		() => {
			void trackBackupOperation(runPeriodicBackupTick(generation));
		},
		intervalMinutes * 60 * 1000,
	);

	// Don't keep the process alive just for backups.
	periodicTimer.unref();
}

export function stopPeriodicBackups(): void {
	periodicGeneration += 1;
	if (periodicTimer !== null) {
		clearInterval(periodicTimer);
		periodicTimer = null;
	}
	lastFingerprint = null;
}

async function runPeriodicBackupTick(generation: number): Promise<void> {
	try {
		const fingerprint = await computeStateFingerprint();
		if (generation !== periodicGeneration) return;
		// Skip if the initial fingerprint hasn't been captured yet (async race on first tick)
		// or if nothing has changed since the last backup.
		if (lastFingerprint === null || fingerprint === lastFingerprint) {
			lastFingerprint = fingerprint;
			return;
		}
		const path = await createBackup({ trigger: "periodic" });
		if (generation === periodicGeneration) lastFingerprint = fingerprint;
		backupLog.info("periodic backup completed", { created: path !== null });
	} catch (error) {
		// Periodic backup failure is non-critical.
		backupLog.warn("periodic backup failed", {
			errorClass: error instanceof Error ? normalizeDiagnosticErrorClass(error.name) : "UnknownError",
		});
	}
}

export const _testing = {
	computeStateFingerprint,
};
