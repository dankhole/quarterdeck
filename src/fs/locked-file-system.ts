import { randomUUID } from "node:crypto";
import { chmod, mkdir, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { LockOptions } from "proper-lockfile";
import * as lockfile from "proper-lockfile";
import { assertRuntimeWriteAdmission, withRuntimeWriteOperation } from "../state/runtime-write-admission.js";
import { inProcessLockOwners } from "./in-process-lock-owners";
import { isNodeError } from "./node-error";
import { removeDirectoryWithRetries } from "./remove-path";

export const DEFAULT_LOCK_STALE_MS = 10_000;
const DEFAULT_LOCK_RETRIES: NonNullable<LockOptions["retries"]> = {
	retries: 200,
	factor: 1,
	minTimeout: 25,
	maxTimeout: 50,
	randomize: false,
};

interface BaseLockRequest {
	path: string;
	staleMs?: number;
	retries?: LockOptions["retries"];
	onCompromised?: LockOptions["onCompromised"];
	/**
	 * Queue this runtime's owners of the same lockfile before polling it. Polling
	 * is unfair: an owner that releases and immediately re-requests wins over
	 * sleeping waiters, so heavily shared locks with slow holds (durable writes on
	 * Windows) can exhaust a waiter's retry budget without any other process.
	 * The retry budget still bounds cross-process contention. A request from an
	 * async context that already holds the lock (re-entry, or detached work it
	 * started) skips the queue and uses that budget, so re-entry fails visibly
	 * instead of deadlocking; still never nest serialized locks in conflicting orders.
	 */
	serializeInProcess?: boolean;
}

export interface FileLockRequest extends BaseLockRequest {
	type?: "file";
	lockfilePath?: string;
}

export interface DirectoryLockRequest extends BaseLockRequest {
	type: "directory";
	lockfileName?: string;
	lockfilePath?: string;
}

export type LockRequest = FileLockRequest | DirectoryLockRequest;

interface NormalizedLockRequest {
	path: string;
	options: LockOptions;
	sortKey: string;
	serializeInProcess: boolean;
}

export interface AtomicTextWriteOptions {
	lock?: LockRequest | null;
	/** Source-owner paths for effects such as publishing backups outside the state home. */
	admissionPaths?: readonly string[];
	executable?: boolean;
	mode?: number;
}

function createLockOptions(request: LockRequest, lockfilePath: string): LockOptions {
	const options: LockOptions = {
		stale: request.staleMs ?? DEFAULT_LOCK_STALE_MS,
		retries: request.retries ?? DEFAULT_LOCK_RETRIES,
		realpath: false,
		lockfilePath,
	};
	if (typeof request.onCompromised === "function") {
		options.onCompromised = request.onCompromised;
	}
	return options;
}

async function readFileIfExists(path: string): Promise<string | null> {
	try {
		return await readFile(path, "utf8");
	} catch (error) {
		if (isNodeError(error, "ENOENT")) {
			return null;
		}
		throw error;
	}
}

/**
 * Remove stale `.lock` directories and orphaned `.tmp.*` files left by previous
 * process crashes. Only removes entries whose mtime is older than {@link staleMs}
 * (default: {@link DEFAULT_LOCK_STALE_MS}), matching `proper-lockfile`'s own
 * staleness threshold. This makes the function safe to call at any time — active
 * locks held by live processes will have a recent mtime and are skipped.
 */
export async function cleanupStaleLockAndTempFiles(
	directories: string[],
	staleMs: number = DEFAULT_LOCK_STALE_MS,
	warn?: (message: string) => void,
): Promise<void> {
	const now = Date.now();
	for (const directory of directories) {
		let entries: string[];
		try {
			entries = await readdir(directory);
		} catch {
			continue;
		}
		for (const entry of entries) {
			if (entry.endsWith(".lock") || entry.includes(".tmp.")) {
				const entryPath = join(directory, entry);
				try {
					const info = await stat(entryPath);
					if (now - info.mtimeMs < staleMs) {
						continue;
					}
					await removeDirectoryWithRetries(entryPath);
					warn?.(`Removed stale artifact: ${entryPath}`);
				} catch {
					// Best-effort cleanup — ignore individual failures.
				}
			}
		}
	}
}

export class LockedFileSystem {
	constructor(private readonly platform: NodeJS.Platform = process.platform) {}

	private async normalizeLockRequest(request: LockRequest): Promise<NormalizedLockRequest> {
		assertRuntimeWriteAdmission(request.path);
		if (request.type === "directory") {
			await mkdir(request.path, { recursive: true });
			const lockfilePath = request.lockfilePath ?? join(request.path, request.lockfileName ?? ".lock");
			return {
				path: request.path,
				options: createLockOptions(request, lockfilePath),
				sortKey: lockfilePath,
				serializeInProcess: request.serializeInProcess === true,
			};
		}

		await mkdir(dirname(request.path), { recursive: true });
		const lockfilePath = request.lockfilePath ?? `${request.path}.lock`;
		return {
			path: request.path,
			options: createLockOptions(request, lockfilePath),
			sortKey: lockfilePath,
			serializeInProcess: request.serializeInProcess === true,
		};
	}

	async withLock<T>(request: LockRequest, operation: () => Promise<T>): Promise<T> {
		return await this.withLocks([request], operation);
	}

	async withLocks<T>(requests: readonly LockRequest[], operation: () => Promise<T>): Promise<T> {
		return await withRuntimeWriteOperation(
			requests.map((request) => request.path),
			async () => await this.withLocksAdmitted(requests, operation),
		);
	}

	private async withLocksAdmitted<T>(requests: readonly LockRequest[], operation: () => Promise<T>): Promise<T> {
		const normalizedRequests = await Promise.all(
			requests.map(async (request) => await this.normalizeLockRequest(request)),
		);
		const caseInsensitive = this.platform === "win32";
		const orderedRequests = normalizedRequests.slice().sort((left, right) => {
			const l = caseInsensitive ? left.sortKey.toLowerCase() : left.sortKey;
			const r = caseInsensitive ? right.sortKey.toLowerCase() : right.sortKey;
			return l.localeCompare(r);
		});
		const uniqueRequests: Array<{ request: NormalizedLockRequest; identity: string }> = [];
		const seenSortKeys = new Set<string>();
		for (const request of orderedRequests) {
			const identity = caseInsensitive ? request.sortKey.toLowerCase() : request.sortKey;
			if (seenSortKeys.has(identity)) continue;
			seenSortKeys.add(identity);
			uniqueRequests.push({ request, identity });
		}
		// Acquire in sorted order; each queued owner keeps its in-process turn until
		// its filesystem lock is released, so the queue always wraps the file lock.
		const acquireFrom = async (index: number): Promise<T> => {
			const entry = uniqueRequests[index];
			if (!entry) {
				for (const { request } of uniqueRequests) assertRuntimeWriteAdmission(request.path);
				return await operation();
			}
			const { request, identity } = entry;
			const acquire = async (): Promise<T> => {
				assertRuntimeWriteAdmission(request.path);
				const release = await lockfile.lock(request.path, request.options);
				try {
					return await acquireFrom(index + 1);
				} finally {
					await release();
				}
			};
			return request.serializeInProcess
				? await inProcessLockOwners.run(identity, request.sortKey, acquire)
				: await acquire();
		};
		return await acquireFrom(0);
	}

	async writeTextFileAtomic(path: string, content: string, options: AtomicTextWriteOptions = {}): Promise<void> {
		const admissionPaths = [path, ...(options.admissionPaths ?? [])];
		const assertAdmission = () => {
			for (const admissionPath of admissionPaths) assertRuntimeWriteAdmission(admissionPath);
		};
		const lockRequest: LockRequest | null =
			options.lock === undefined
				? {
						path,
						type: "file" as const,
					}
				: options.lock;
		const writeOperation = async () =>
			await withRuntimeWriteOperation(admissionPaths, async () => {
				const existingContent = await readFileIfExists(path);
				if (existingContent === content) {
					assertAdmission();
					if (options.executable && this.platform !== "win32") {
						await chmod(path, 0o755);
					} else if (options.mode !== undefined && this.platform !== "win32") {
						await chmod(path, options.mode);
					}
					return;
				}
				assertAdmission();
				await mkdir(dirname(path), { recursive: true });
				const tempPath = `${path}.tmp.${process.pid}.${Date.now()}.${randomUUID()}`;
				assertAdmission();
				await writeFile(tempPath, content, {
					encoding: "utf8",
					...(options.mode !== undefined && this.platform !== "win32" ? { mode: options.mode } : {}),
				});
				assertAdmission();
				await rename(tempPath, path);
				assertAdmission();
				if (options.executable && this.platform !== "win32") {
					await chmod(path, 0o755);
				} else if (options.mode !== undefined && this.platform !== "win32") {
					await chmod(path, options.mode);
				}
			});
		if (lockRequest) {
			await this.withLock(lockRequest, writeOperation);
			return;
		}
		await writeOperation();
	}

	async writeJsonFileAtomic(
		path: string,
		payload: unknown,
		options: Omit<AtomicTextWriteOptions, "executable"> = {},
	): Promise<void> {
		await this.writeTextFileAtomic(path, JSON.stringify(payload, null, 2), options);
	}

	async removePath(path: string, options: { lock: LockRequest; recursive?: boolean; force?: boolean }): Promise<void> {
		await this.withLock(options.lock, async () => {
			assertRuntimeWriteAdmission(path);
			await rm(path, {
				recursive: options.recursive,
				force: options.force,
				...(options.recursive ? { maxRetries: 10, retryDelay: 100 } : {}),
			});
		});
	}
}

export const lockedFileSystem = new LockedFileSystem();
