import { stat } from "node:fs/promises";

import type { RuntimeBoardData } from "../core";
import { isNodeError } from "../fs/node-error";
import { readProjectBoardUnderLock, readProjectMetaUnderLock } from "./project-state-index";
import {
	getProjectStateInstallGeneration,
	hasPendingProjectStateTransaction,
	withProjectStateLock,
} from "./project-state-transaction";
import { getProjectBoardPath, getProjectMetaPath } from "./project-state-utils";

/** Off-switch: disabled, every read takes the project state lock and rereads the file. */
export const PROJECT_BOARD_READ_CACHE_ENABLED = true;

interface CachedRead<T> {
	value: T;
	fileToken: string;
	installGeneration: number;
}

async function readFileToken(path: string): Promise<string> {
	try {
		// Every committed state file is replaced by atomic rename (new inode) and the
		// kernel sets ctime on any write, so a same-size rewrite still changes this.
		const info = await stat(path, { bigint: true });
		return [info.dev, info.ino, info.size, info.mtimeNs, info.ctimeNs].join(":");
	} catch (error) {
		if (isNodeError(error, "ENOENT")) return "absent";
		throw error;
	}
}

function deepFreeze<T>(value: T): T {
	if (value && typeof value === "object" && !Object.isFrozen(value)) {
		Object.freeze(value);
		for (const child of Object.values(value)) deepFreeze(child);
	}
	return value;
}

/**
 * Lock-free reuse of committed board state for periodic, derived readers (the
 * native title poll and project-list summaries). Not an authority: writers,
 * snapshots, and command validation keep the locked read path.
 *
 * An entry is served only while no transaction journal is pending, this
 * process has started no install for the project, and the source file has the
 * same identity it had when the entry was read under the lock. Any other
 * writer (another runtime or CLI, backup restore, journal recovery) replaces
 * the file, so the next read falls back to the locked path, which also
 * finishes a pending journal. A read racing a commit returns the state
 * committed before it, exactly as a locked reader queued ahead of the writer.
 */
export class ProjectBoardReadCache {
	private readonly boards = new Map<string, CachedRead<RuntimeBoardData>>();
	private readonly revisions = new Map<string, CachedRead<number>>();

	constructor(private readonly enabled = PROJECT_BOARD_READ_CACHE_ENABLED) {}

	/** Committed board, deep-frozen and shared between callers; never mutate it. */
	async loadBoard(projectId: string): Promise<RuntimeBoardData> {
		return await this.load(this.boards, projectId, getProjectBoardPath(projectId), async () =>
			deepFreeze(await readProjectBoardUnderLock(projectId)),
		);
	}

	async loadBoardRevision(projectId: string): Promise<number> {
		return await this.load(
			this.revisions,
			projectId,
			getProjectMetaPath(projectId),
			async () => (await readProjectMetaUnderLock(projectId)).revision,
		);
	}

	forget(projectId: string): void {
		this.boards.delete(projectId);
		this.revisions.delete(projectId);
	}

	private async load<T>(
		entries: Map<string, CachedRead<T>>,
		projectId: string,
		path: string,
		readUnderLock: () => Promise<T>,
	): Promise<T> {
		if (!this.enabled) return await withProjectStateLock(projectId, readUnderLock);
		const cached = entries.get(projectId);
		// The journal check must precede the identity check: a journal appearing
		// after it can only belong to a commit this read is ordered before.
		if (
			cached &&
			!(await hasPendingProjectStateTransaction(projectId)) &&
			(await readFileToken(path)) === cached.fileToken &&
			getProjectStateInstallGeneration(projectId) === cached.installGeneration
		) {
			return cached.value;
		}
		return await withProjectStateLock(projectId, async () => {
			const installGeneration = getProjectStateInstallGeneration(projectId);
			const fileToken = await readFileToken(path);
			const value = await readUnderLock();
			entries.set(projectId, { value, fileToken, installGeneration });
			return value;
		});
	}
}

/** Process-wide instance shared by the runtime's periodic readers. */
export const projectBoardReadCache = new ProjectBoardReadCache();
