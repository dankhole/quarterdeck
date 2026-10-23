import { randomUUID } from "node:crypto";
import { mkdir, readdir, rename } from "node:fs/promises";
import { join } from "node:path";
import pLimit from "p-limit";

import { createTaggedLogger } from "../core/runtime-logger";
import { isNodeError } from "../fs/node-error";
import { removeDirectoryWithRetries } from "../fs/remove-path";
import { getTaskWorktreesHomePath } from "../state/project-state-utils";
import { assertRuntimeWriteAdmission } from "../state/runtime-write-admission.js";

// Task ids may not contain "..", so this can never collide with a task folder.
const PENDING_DELETE_DIR = "..pending-delete";
const log = createTaggedLogger("task-worktree-deferred-delete");

/** Rename refusals that mean "delete in place instead": another volume, or open Windows handles. */
const IN_PLACE_DELETE_CODES = ["EXDEV", "EPERM", "EACCES", "EBUSY"] as const;

export function getPendingTaskWorkspaceDeleteRoot(): string {
	return join(getTaskWorktreesHomePath(), PENDING_DELETE_DIR);
}

/**
 * Atomically moves a task workspace out of its managed path so permanent deletion
 * can finish without holding repository locks while its files are removed.
 * Returns null when the folder cannot be renamed and must be deleted in place.
 */
export async function stageTaskWorkspaceForDelete(worktreePath: string, taskId: string): Promise<string | null> {
	const root = getPendingTaskWorkspaceDeleteRoot();
	const stagedPath = join(root, `${taskId}-${randomUUID()}`);
	assertRuntimeWriteAdmission(worktreePath);
	assertRuntimeWriteAdmission(stagedPath);
	await mkdir(root, { recursive: true });
	try {
		await rename(worktreePath, stagedPath);
		return stagedPath;
	} catch (error) {
		if (IN_PLACE_DELETE_CODES.some((code) => isNodeError(error, code))) return null;
		throw error;
	}
}

/** One staged workspace at a time; the removal lane separately bounds filesystem calls. */
class DeferredTaskWorkspaceDeleter {
	private readonly queue = pLimit(1);
	private readonly scheduled = new Map<string, Promise<void>>();
	private controller = new AbortController();

	schedule(stagedPath: string): void {
		if (this.scheduled.has(stagedPath)) return;
		const signal = this.controller.signal;
		const deletion = this.queue(async () => {
			const startedAt = Date.now();
			await removeDirectoryWithRetries(stagedPath, { lane: "background", signal });
			log.info("deferred task workspace delete completed", { durationMs: Date.now() - startedAt });
		})
			.catch((error: unknown) => {
				// Leftovers stay staged and are retried on the next runtime start.
				if (!signal.aborted) log.warn("deferred task workspace delete failed", { error: String(error) });
			})
			.finally(() => this.scheduled.delete(stagedPath));
		this.scheduled.set(stagedPath, deletion);
	}

	async scheduleLeftovers(): Promise<void> {
		const root = getPendingTaskWorkspaceDeleteRoot();
		try {
			for (const entry of await readdir(root)) this.schedule(join(root, entry));
		} catch (error) {
			if (!isNodeError(error, "ENOENT")) throw error;
		}
	}

	/** Shutdown must not wait for a large tree; remaining files are retried on the next start. */
	abort(): void {
		this.controller.abort();
		this.controller = new AbortController();
	}

	async whenIdle(): Promise<void> {
		while (this.scheduled.size > 0) await Promise.all(this.scheduled.values());
	}
}

export const deferredTaskWorkspaceDeletes = new DeferredTaskWorkspaceDeleter();
