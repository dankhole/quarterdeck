import { lstat, readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import pLimit from "p-limit";

import { assertRuntimeWriteAdmission, withRuntimeWriteOperation } from "../state/runtime-write-admission.js";

const RECURSIVE_REMOVE_MAX_RETRIES = 10;
const RECURSIVE_REMOVE_RETRY_DELAY_MS = 100;

/**
 * Process-wide cap on in-flight filesystem calls made by recursive removal.
 * Node's recursive `rm` fans out every directory entry at once, so deleting a
 * large tree (a worktree's node_modules or .venv) fills libuv's shared thread
 * pool queue and stalls every unrelated file read, lock, and hook write in the
 * runtime until the delete finishes. Keeping removal below the default pool
 * size leaves threads free for the rest of the runtime.
 */
export const RECURSIVE_REMOVE_FS_CONCURRENCY = 2;
/** Deferred deletes get their own lane so request-path removals never queue behind a large tree. */
const BACKGROUND_REMOVE_FS_CONCURRENCY = 1;
const removeLanes = {
	foreground: pLimit(RECURSIVE_REMOVE_FS_CONCURRENCY),
	background: pLimit(BACKGROUND_REMOVE_FS_CONCURRENCY),
};

export interface RemoveDirectoryOptions {
	force?: boolean;
	lane?: keyof typeof removeLanes;
	/** Stops issuing filesystem calls; an aborted removal leaves the remaining entries in place. */
	signal?: AbortSignal;
}

type RemoveFsCall = <T>(call: () => Promise<T>) => Promise<T>;

function createRemoveFsCall(options: RemoveDirectoryOptions): RemoveFsCall {
	const limit = removeLanes[options.lane ?? "foreground"];
	return (call) =>
		limit(() => {
			options.signal?.throwIfAborted();
			return call();
		});
}

const RM_ENTRY_OPTIONS = {
	recursive: true,
	force: true,
	maxRetries: RECURSIVE_REMOVE_MAX_RETRIES,
	retryDelay: RECURSIVE_REMOVE_RETRY_DELAY_MS,
} as const;

/** Removes one directory's entries, then the directory itself, gating each filesystem call. */
async function removeDirectoryTree(path: string, force: boolean, removeFsCalls: RemoveFsCall): Promise<void> {
	const entries = await removeFsCalls(() => readdir(path, { withFileTypes: true }));
	await Promise.all(
		entries.map((entry) => {
			const entryPath = join(path, entry.name);
			// Dirent types never follow symlinks. Unknown types fall through to `rm`, which lstat()s.
			return entry.isDirectory()
				? removeDirectoryTree(entryPath, true, removeFsCalls)
				: removeFsCalls(() => rm(entryPath, RM_ENTRY_OPTIONS));
		}),
	);
	// Recursive so entries created during the walk are still removed, with Windows handle retries.
	await removeFsCalls(() => rm(path, { ...RM_ENTRY_OPTIONS, force }));
}

/** Removes a directory tree while tolerating bounded transient Windows handle races. */
export async function removeDirectoryWithRetries(path: string, options: RemoveDirectoryOptions = {}): Promise<void> {
	const force = options.force ?? true;
	const removeFsCalls = createRemoveFsCall(options);
	await withRuntimeWriteOperation([path], async () => {
		assertRuntimeWriteAdmission(path);
		let isDirectory: boolean;
		try {
			isDirectory = (await removeFsCalls(() => lstat(path))).isDirectory();
		} catch (error) {
			if (force && (error as NodeJS.ErrnoException).code === "ENOENT") return;
			throw error;
		}
		if (isDirectory) await removeDirectoryTree(path, force, removeFsCalls);
		// Files and symlinks are removed without following them, matching `rm`.
		else await removeFsCalls(() => rm(path, { ...RM_ENTRY_OPTIONS, force }));
	});
}
