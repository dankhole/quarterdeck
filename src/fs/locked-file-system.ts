import { randomUUID } from "node:crypto";
import { chmod, mkdir, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { LockOptions } from "proper-lockfile";
import * as lockfile from "proper-lockfile";
import { isNodeError } from "./node-error";

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
}

export interface AtomicTextWriteOptions {
	lock?: LockRequest | null;
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
					await rm(entryPath, { recursive: true, force: true });
					warn?.(`Removed stale artifact: ${entryPath}`);
				} catch {
					// Best-effort cleanup — ignore individual failures.
				}
			}
		}
	}
}

export class LockedFileSystem {
	private async normalizeLockRequest(request: LockRequest): Promise<NormalizedLockRequest> {
		if (request.type === "directory") {
			await mkdir(request.path, { recursive: true });
			const lockfilePath = request.lockfilePath ?? join(request.path, request.lockfileName ?? ".lock");
			return {
				path: request.path,
				options: createLockOptions(request, lockfilePath),
				sortKey: lockfilePath,
			};
		}

		await mkdir(dirname(request.path), { recursive: true });
		const lockfilePath = request.lockfilePath ?? `${request.path}.lock`;
		return {
			path: request.path,
			options: createLockOptions(request, lockfilePath),
			sortKey: lockfilePath,
		};
	}

	async withLock<T>(request: LockRequest, operation: () => Promise<T>): Promise<T> {
		return await this.withLocks([request], operation);
	}

	async withLocks<T>(requests: readonly LockRequest[], operation: () => Promise<T>): Promise<T> {
		const normalizedRequests = await Promise.all(
			requests.map(async (request) => await this.normalizeLockRequest(request)),
		);
		const caseInsensitive = process.platform === "win32";
		const orderedRequests = normalizedRequests.slice().sort((left, right) => {
			const l = caseInsensitive ? left.sortKey.toLowerCase() : left.sortKey;
			const r = caseInsensitive ? right.sortKey.toLowerCase() : right.sortKey;
			return l.localeCompare(r);
		});
		const releases: Array<() => Promise<void>> = [];
		try {
			for (const request of orderedRequests) {
				releases.push(await lockfile.lock(request.path, request.options));
			}
			return await operation();
		} finally {
			for (const release of releases.reverse()) {
				await release();
			}
		}
	}

	async writeTextFileAtomic(path: string, content: string, options: AtomicTextWriteOptions = {}): Promise<void> {
		const lockRequest: LockRequest | null =
			options.lock === undefined
				? {
						path,
						type: "file" as const,
					}
				: options.lock;
		const writeOperation = async () => {
			const existingContent = await readFileIfExists(path);
			if (existingContent === content) {
				if (options.executable && process.platform !== "win32") {
					await chmod(path, 0o755);
				} else if (options.mode !== undefined && process.platform !== "win32") {
					await chmod(path, options.mode);
				}
				return;
			}
			await mkdir(dirname(path), { recursive: true });
			const tempPath = `${path}.tmp.${process.pid}.${Date.now()}.${randomUUID()}`;
			await writeFile(tempPath, content, "utf8");
			await rename(tempPath, path);
			if (options.executable && process.platform !== "win32") {
				await chmod(path, 0o755);
			} else if (options.mode !== undefined && process.platform !== "win32") {
				await chmod(path, options.mode);
			}
		};
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
			await rm(path, {
				recursive: options.recursive,
				force: options.force,
			});
		});
	}
}

export const lockedFileSystem = new LockedFileSystem();
