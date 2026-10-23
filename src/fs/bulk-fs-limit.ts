import pLimit from "p-limit";

/**
 * Process-wide cap on in-flight filesystem calls made by per-path fan-out in
 * polling, diff, and file-tree code (git status fingerprinting, untracked-file
 * line counts, Changes-panel fingerprinting, directory open/read/close).
 * Unbounded fan-out floods libuv's shared thread pool queue and stalls every
 * unrelated file read, lock, and hook write until it drains. This lane
 * is separate from the removal lane in `remove-path.ts`, which gates
 * recursive deletes.
 */
export const BULK_FS_CONCURRENCY = 2;
export const limitBulkFsCall = pLimit(BULK_FS_CONCURRENCY);
