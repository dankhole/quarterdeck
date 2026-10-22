// Task image maintenance for runtime-owned board writes: one-time legacy
// migration with failure backoff, and unreferenced-blob sweeps. The store in
// task-image-store.ts is the mechanism; this module decides when to run it.
// State is per process and keyed by project state directory, so a runtime
// sweeps each project on its first write (covering failed-commit orphans and
// post-restore extras) and again once deferred entries leave the grace window.

import type { RuntimeBoardData, RuntimePersistedBoardData } from "../core";
import { createTaggedLogger, normalizeDiagnosticErrorClass } from "../core";
import {
	type ProjectStateMeta,
	type ReadProjectSessionsResult,
	readProjectBoardUnderLock,
	readProjectMetaUnderLock,
	readProjectSessionsUnderLock,
} from "./project-state-index";
import { hasPendingProjectStateTransaction, writeProjectStateTransaction } from "./project-state-transaction";
import { getProjectDirectoryPath } from "./project-state-utils";
import {
	boardHasInlineTaskImages,
	collectBoardTaskImageHashes,
	collectUnreferencedTaskImagesUnderLock,
	externalizeBoardTaskImagesUnderLock,
} from "./task-image-store";

const log = createTaggedLogger("task-image-maintenance");

/** First retry delay after a legacy inline image migration fails. */
export const LEGACY_IMAGE_MIGRATION_INITIAL_BACKOFF_MS = 60_000;
/** Upper bound for repeated migration failures (each failure doubles the delay). */
export const LEGACY_IMAGE_MIGRATION_MAX_BACKOFF_MS = 30 * 60_000;
/** Delay before retrying a sweep that failed outright. */
export const TASK_IMAGE_SWEEP_RETRY_MS = 60_000;

interface MigrationBackoff {
	retryAt: number;
	delayMs: number;
}

const migrationBackoffByProject = new Map<string, MigrationBackoff>();
const sweepDueAtByProject = new Map<string, number>();

export function isLegacyImageMigrationDeferred(projectKey: string, now: number): boolean {
	const backoff = migrationBackoffByProject.get(projectKey);
	return backoff !== undefined && now < backoff.retryAt;
}

/** Records a failed attempt and returns the delay until the next one. */
export function deferLegacyImageMigration(projectKey: string, now: number): number {
	const previous = migrationBackoffByProject.get(projectKey);
	const delayMs = previous
		? Math.min(previous.delayMs * 2, LEGACY_IMAGE_MIGRATION_MAX_BACKOFF_MS)
		: LEGACY_IMAGE_MIGRATION_INITIAL_BACKOFF_MS;
	migrationBackoffByProject.set(projectKey, { retryAt: now + delayMs, delayMs });
	return delayMs;
}

export function clearLegacyImageMigrationBackoff(projectKey: string): void {
	migrationBackoffByProject.delete(projectKey);
}

/** True until this process has swept the project, then whenever deferred entries become collectable. */
export function isTaskImageSweepDue(projectKey: string, now: number): boolean {
	const dueAt = sweepDueAtByProject.get(projectKey);
	return dueAt === undefined || dueAt <= now;
}

export function scheduleTaskImageSweep(projectKey: string, nextSweepAt: number | null): void {
	sweepDueAtByProject.set(projectKey, nextSweepAt ?? Number.POSITIVE_INFINITY);
}

function toErrorClass(error: unknown): string {
	return error instanceof Error ? normalizeDiagnosticErrorClass(error.name) : "UnknownError";
}

function getProjectKey(projectId: string): string {
	return getProjectDirectoryPath(projectId);
}

async function sweepTaskImagesIfDueUnderLock(projectId: string, board: RuntimeBoardData): Promise<void> {
	const key = getProjectKey(projectId);
	const now = Date.now();
	if (!isTaskImageSweepDue(key, now)) return;
	try {
		scheduleTaskImageSweep(
			key,
			(await collectUnreferencedTaskImagesUnderLock(projectId, board, { now })).nextSweepAt,
		);
	} catch (error) {
		scheduleTaskImageSweep(key, now + TASK_IMAGE_SWEEP_RETRY_MS);
		log.warn("task image sweep failed", { projectId, errorClass: toErrorClass(error) });
	}
}

/**
 * One journaled, format-only commit (unchanged revision, receipts, and on-disk
 * sessions). Storage failures before the journal defer with backoff and keep
 * the legacy board; a journal that reached disk is committed, so its failure
 * must fail the write rather than let a later direct session save be replaced
 * when the next lock holder recovers it.
 */
async function migrateLegacyTaskImagesUnderLock(
	projectId: string,
	board: RuntimeBoardData,
	onSessionsRead: (result: ReadProjectSessionsResult) => void,
): Promise<RuntimeBoardData> {
	const key = getProjectKey(projectId);
	const now = Date.now();
	if (isLegacyImageMigrationDeferred(key, now)) return board;
	const defer = (error: unknown): RuntimeBoardData => {
		const retryInMs = deferLegacyImageMigration(key, now);
		log.warn("legacy task image migration deferred", { projectId, errorClass: toErrorClass(error), retryInMs });
		return board;
	};
	let migrated: RuntimePersistedBoardData;
	let meta: ProjectStateMeta;
	let sessionsResult: ReadProjectSessionsResult;
	try {
		migrated = await externalizeBoardTaskImagesUnderLock(projectId, board, new Set());
		meta = await readProjectMetaUnderLock(projectId);
		sessionsResult = await readProjectSessionsUnderLock(projectId);
	} catch (error) {
		return defer(error);
	}
	onSessionsRead(sessionsResult);
	try {
		await writeProjectStateTransaction(projectId, { board: migrated, sessions: sessionsResult.sessions, meta });
	} catch (error) {
		if (await hasPendingProjectStateTransaction(projectId)) throw error;
		return defer(error);
	}
	clearLegacyImageMigrationBackoff(key);
	log.info("externalized legacy inline task images", { projectId });
	return migrated;
}

/**
 * Requires the project lock. Board read for runtime-owned write paths
 * (`applyProjectBoardMutation`, including session-only no-op saves): migrates
 * a legacy inline board once and runs any due unreferenced-blob sweep.
 */
export async function readProjectBoardForWriteUnderLock(
	projectId: string,
	onSessionsRead: (result: ReadProjectSessionsResult) => void,
): Promise<RuntimeBoardData> {
	const board = await readProjectBoardUnderLock(projectId);
	if (boardHasInlineTaskImages(board)) return await migrateLegacyTaskImagesUnderLock(projectId, board, onSessionsRead);
	clearLegacyImageMigrationBackoff(getProjectKey(projectId));
	await sweepTaskImagesIfDueUnderLock(projectId, board);
	return board;
}

/** Requires the project lock. Stores inline uploads and verifies new references before a board commit. */
export async function externalizeBoardForCommitUnderLock(
	projectId: string,
	previousBoard: RuntimeBoardData,
	board: RuntimeBoardData,
): Promise<RuntimePersistedBoardData> {
	return await externalizeBoardTaskImagesUnderLock(projectId, board, collectBoardTaskImageHashes(previousBoard));
}

/** Requires the project lock, after commit. Collection failure never affects the committed result. */
export async function collectDroppedTaskImagesUnderLock(
	projectId: string,
	previousBoard: RuntimeBoardData,
	board: RuntimePersistedBoardData,
): Promise<void> {
	const retained = collectBoardTaskImageHashes(board);
	if ([...collectBoardTaskImageHashes(previousBoard)].every((hash) => retained.has(hash))) return;
	const key = getProjectKey(projectId);
	try {
		scheduleTaskImageSweep(key, (await collectUnreferencedTaskImagesUnderLock(projectId, board)).nextSweepAt);
	} catch (error) {
		scheduleTaskImageSweep(key, Date.now() + TASK_IMAGE_SWEEP_RETRY_MS);
		log.warn("task image collection failed", { projectId, errorClass: toErrorClass(error) });
	}
}
