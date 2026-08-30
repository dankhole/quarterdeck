import {
	pruneOrphanSessionsForPersist,
	type RuntimeProjectStateResponse,
	type RuntimeTaskSessionReviewReason,
	type RuntimeTaskSessionSummary,
} from "../core";
import { listProjectIndexEntries, loadProjectState, saveProjectSessions } from "../state";
import type { TerminalSessionManager } from "../terminal";
import { killOrphanedAgentProcesses } from "../terminal";
import type { ProjectRegistry } from "./project-registry";

export interface RuntimeShutdownCoordinatorDependencies {
	projectRegistry: Pick<ProjectRegistry, "listManagedProjects"> & {
		stopMaintenance?: () => void;
	};
	warn: (message: string) => void;
	closeRuntimeServer: () => Promise<void>;
	skipSessionCleanup?: boolean;
	/** Agent Lab owns its synthetic child tree and must not scan unrelated host processes. */
	skipOrphanProcessCleanup?: boolean;
}

/**
 * Persist interrupted session state without moving cards or deleting worktrees.
 * Cards stay in their current columns so the board survives a restart. Worktrees
 * are left on disk so agent conversation history (`.claude/`, etc.) is preserved
 * and `--continue` works on resume.
 */
async function persistInterruptedSessions(
	projectPath: string,
	interruptedTaskIds: string[],
	options?: {
		projectState?: RuntimeProjectStateResponse;
		resolveSummary?: (taskId: string) => RuntimeTaskSessionSummary | null;
	},
): Promise<void> {
	if (interruptedTaskIds.length === 0) {
		return;
	}
	const projectState = options?.projectState ?? (await loadProjectState(projectPath));
	const nextSessions = {
		...projectState.sessions,
	};
	for (const taskId of interruptedTaskIds) {
		const runtimeSummary = options?.resolveSummary?.(taskId) ?? null;
		if (runtimeSummary) {
			// The runtime store already projected process shutdown while preserving
			// Review/Needs Input/Error meaning. Persist that authoritative summary
			// verbatim instead of reclassifying it from the older disk snapshot.
			nextSessions[taskId] = runtimeSummary;
			continue;
		}
		const summary = projectState.sessions[taskId] ?? null;
		if (summary && shouldInterruptSessionOnShutdown(summary)) {
			nextSessions[taskId] = {
				...summary,
				state: "awaiting_review",
				reviewReason: "interrupted",
				pid: null,
				latestHookActivity: null,
				stalledSince: null,
				startupRecoveryRequired: true,
				updatedAt: Date.now(),
			};
		}
	}
	await saveProjectSessions(projectPath, pruneOrphanSessionsForPersist(nextSessions, projectState.board));
}

/** Review reasons whose semantic meaning must survive shutdown unchanged. */
const TERMINAL_REVIEW_REASONS = new Set<RuntimeTaskSessionReviewReason>([
	"hook",
	"exit",
	"error",
	"attention",
	"interrupted",
	"stalled",
]);

function shouldInterruptSessionOnShutdown(summary: RuntimeTaskSessionSummary): boolean {
	if (summary.reviewReason === "interrupted") {
		// markInterruptedAndStopAll() mutates active in-memory summaries before
		// shutdown persistence runs. Those already-interrupted summaries are the
		// exact records startup resume needs on disk.
		return true;
	}
	if (summary.state === "running") {
		return true;
	}
	if (summary.state === "awaiting_review") {
		// Terminal review reasons are already non-resumable — don't overwrite.
		return !TERMINAL_REVIEW_REASONS.has(summary.reviewReason);
	}
	return false;
}

function collectShutdownInterruptedTaskIds(
	interruptedSummaries: RuntimeTaskSessionSummary[],
	terminalManager: TerminalSessionManager,
): string[] {
	const taskIds = new Set(interruptedSummaries.map((summary) => summary.taskId));
	for (const summary of terminalManager.store.listSummaries()) {
		if (!shouldInterruptSessionOnShutdown(summary)) {
			continue;
		}
		taskIds.add(summary.taskId);
	}
	return Array.from(taskIds);
}

/** Collect task IDs from all work columns (everything except backlog and trash). */
function collectWorkColumnTaskIds(projectState: RuntimeProjectStateResponse): string[] {
	const taskIds: string[] = [];
	for (const column of projectState.board.columns) {
		if (column.id === "backlog" || column.id === "trash") {
			continue;
		}
		for (const card of column.cards) {
			taskIds.push(card.id);
		}
	}
	return taskIds;
}

export async function shutdownRuntimeServer(deps: RuntimeShutdownCoordinatorDependencies): Promise<void> {
	deps.projectRegistry.stopMaintenance?.();

	if (deps.skipSessionCleanup) {
		await deps.closeRuntimeServer();
		return;
	}

	const interruptedByProject: Array<{
		projectPath: string;
		interruptedTaskIds: string[];
		projectState?: RuntimeProjectStateResponse;
		resolveSummary?: (taskId: string) => RuntimeTaskSessionSummary | null;
	}> = [];
	const managedProjectIds = new Set<string>();
	const shutdownQuiescence: Promise<void>[] = [];

	for (const { projectId, projectPath, terminalManager } of deps.projectRegistry.listManagedProjects()) {
		terminalManager.stopReconciliation();
		const interrupted = terminalManager.markInterruptedAndStopAll();
		shutdownQuiescence.push(terminalManager.waitForShutdownQuiescence());
		const interruptedTaskIds = new Set(collectShutdownInterruptedTaskIds(interrupted, terminalManager));
		if (!projectPath) {
			continue;
		}
		managedProjectIds.add(projectId);
		try {
			const projectState = await loadProjectState(projectPath);
			for (const taskId of collectWorkColumnTaskIds(projectState)) {
				interruptedTaskIds.add(taskId);
			}
			interruptedByProject.push({
				projectPath,
				interruptedTaskIds: Array.from(interruptedTaskIds),
				projectState,
				resolveSummary: (taskId) => terminalManager.store.getSummary(taskId),
			});
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			deps.warn(`Could not load project state for ${projectPath} during shutdown cleanup. ${message}`);
		}
	}
	const indexedProjects = await listProjectIndexEntries();
	for (const indexed of indexedProjects) {
		if (managedProjectIds.has(indexed.projectId)) {
			continue;
		}
		try {
			const projectState = await loadProjectState(indexed.repoPath);
			// Over-collects — tasks without a pre-existing session record are
			// silently skipped by persistInterruptedSessions's `if (summary)` guard.
			const interruptedTaskIds = collectWorkColumnTaskIds(projectState);
			if (interruptedTaskIds.length === 0) {
				continue;
			}
			interruptedByProject.push({
				projectPath: indexed.repoPath,
				interruptedTaskIds,
				projectState,
			});
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			deps.warn(`Could not load project state for ${indexed.repoPath} during shutdown cleanup. ${message}`);
		}
	}

	// Start exact-owned orphan cleanup as soon as active PTYs have received their
	// stop request. Windows console-close gives the runtime only a short fixed
	// lifetime, so waiting until persistence and server close have completed can
	// leave no time for the CIM identity recheck and taskkill. The promise remains
	// awaited after server close, preserving the external shutdown contract.
	const orphanCleanupPromise = deps.skipOrphanProcessCleanup
		? Promise.resolve()
		: killOrphanedAgentProcesses({ includeCurrentRuntime: true })
				.then(() => undefined)
				.catch(() => undefined);

	// Wrap cleanup I/O in a timeout so closeRuntimeServer() always gets called
	// orderly. Without this, a hung git operation or stale filesystem write blocks
	// until the hard 10s process-level timeout kills us mid-I/O, skipping server
	// close entirely.
	const CLEANUP_TIMEOUT_MS = 7000;
	const cleanupPromise = (async () => {
		await Promise.all(shutdownQuiescence);
		await Promise.all(
			interruptedByProject.map(async (entry) => {
				await persistInterruptedSessions(entry.projectPath, entry.interruptedTaskIds, {
					projectState: entry.projectState,
					resolveSummary: entry.resolveSummary,
				});
			}),
		);
	})();
	const timeoutPromise = new Promise<"timeout">((resolve) => setTimeout(() => resolve("timeout"), CLEANUP_TIMEOUT_MS));
	const result = await Promise.race([cleanupPromise.then(() => "done" as const), timeoutPromise]);
	if (result === "timeout") {
		deps.warn(`Shutdown cleanup timed out after ${CLEANUP_TIMEOUT_MS}ms. Closing server without full cleanup.`);
	}

	await deps.closeRuntimeServer();

	// Await best-effort cleanup so discovery has a chance to signal exact owned
	// stragglers before the graceful-shutdown handler exits the process.
	await orphanCleanupPromise;
}
