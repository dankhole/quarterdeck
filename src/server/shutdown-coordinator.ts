import {
	pruneOrphanSessionsForPersist,
	type RuntimeOwnedProcessShutdownOutcome,
	type RuntimeProjectStateResponse,
	type RuntimeShutdownIncompleteReason,
	type RuntimeShutdownOutcome,
	type RuntimeTaskSessionReviewReason,
	type RuntimeTaskSessionSummary,
} from "../core";
import { listProjectIndexEntries, loadSavedProjectStateById, saveProjectSessions } from "../state";
import type { TerminalSessionManager } from "../terminal";
import type { ProjectRegistry } from "./project-registry";

export interface RuntimeShutdownCoordinatorDependencies {
	projectRegistry: Pick<ProjectRegistry, "listManagedProjects"> & {
		stopMaintenance?: () => void;
	};
	warn: (message: string) => void;
	closeRuntimeServer: () => Promise<void>;
	/** Reject new mutations and drain runtime producers before the final session snapshot. */
	prepareForShutdown?: () => Promise<void>;
	/** Close process launch admission only after admitted producer drains have settled. */
	beforeProcessSnapshot?: () => void;
	/** Capture exact-owned roots, call stopSessions, then confirm descendants stopped. */
	stopOwnedProcesses?: (stopSessions: () => void) => Promise<RuntimeOwnedProcessShutdownOutcome>;
	/** State writers must also enforce this fence at their own mutation boundary. */
	persistenceAllowed?: () => boolean;
	skipSessionCleanup?: boolean;
	/** @deprecated Shutdown never scans unrelated host processes. */
	skipOrphanProcessCleanup?: boolean;
	cleanupTimeoutMs?: number;
}

export interface RuntimeShutdownResult {
	outcome: RuntimeShutdownOutcome;
	/**
	 * Settles only after every started write, close, and owned-process cleanup has
	 * settled. A deadline report does not cancel I/O or release the lifetime lease.
	 */
	completion: Promise<RuntimeShutdownOutcome>;
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
	options: {
		projectState: RuntimeProjectStateResponse;
		resolveSummary?: (taskId: string) => RuntimeTaskSessionSummary | null;
	},
): Promise<void> {
	if (interruptedTaskIds.length === 0) {
		return;
	}
	const projectState = options.projectState;
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

/** Collect task IDs from all work columns (started cards outside Trash). */
function collectWorkColumnTaskIds(projectState: RuntimeProjectStateResponse): string[] {
	const taskIds: string[] = [];
	for (const column of projectState.board.columns) {
		if (column.id === "trash") {
			continue;
		}
		for (const card of column.cards) {
			if (card.unstarted) continue;
			taskIds.push(card.id);
		}
	}
	return taskIds;
}

async function persistShutdownSessions(
	deps: RuntimeShutdownCoordinatorDependencies,
	managedProjects: ReturnType<ProjectRegistry["listManagedProjects"]>,
	interruptedSummaries: Map<TerminalSessionManager, RuntimeTaskSessionSummary[]>,
	recordFailure: (reason: RuntimeShutdownIncompleteReason, message: string) => void,
): Promise<void> {
	const interruptedByProject: Array<{
		projectPath: string;
		interruptedTaskIds: string[];
		projectState: RuntimeProjectStateResponse;
		resolveSummary?: (taskId: string) => RuntimeTaskSessionSummary | null;
	}> = [];
	const managedProjectIds = new Set<string>();
	const persistenceAllowed = () => deps.persistenceAllowed?.() ?? true;

	for (const { projectId, projectPath, terminalManager } of managedProjects) {
		if (!persistenceAllowed()) return;
		const interrupted = interruptedSummaries.get(terminalManager) ?? [];
		const interruptedTaskIds = new Set(collectShutdownInterruptedTaskIds(interrupted, terminalManager));
		if (!projectPath) {
			continue;
		}
		managedProjectIds.add(projectId);
		try {
			const projectState = await loadSavedProjectStateById(projectId);
			if (!projectState) throw new Error("Saved project state is unavailable.");
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
			recordFailure(
				"persistence_failed",
				`Could not load project state for ${projectPath} during shutdown cleanup. ${message}`,
			);
		}
	}
	if (!persistenceAllowed()) return;
	let indexedProjects: Awaited<ReturnType<typeof listProjectIndexEntries>> = [];
	try {
		indexedProjects = await listProjectIndexEntries();
	} catch (error) {
		recordFailure("persistence_failed", `Could not load the project index during shutdown cleanup. ${String(error)}`);
	}
	for (const indexed of indexedProjects) {
		if (!persistenceAllowed()) return;
		if (managedProjectIds.has(indexed.projectId)) {
			continue;
		}
		try {
			const projectState = await loadSavedProjectStateById(indexed.projectId);
			if (!projectState) throw new Error("Saved project state is unavailable.");
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
			recordFailure(
				"persistence_failed",
				`Could not load project state for ${indexed.repoPath} during shutdown cleanup. ${message}`,
			);
		}
	}
	// allSettled retains the lifetime of sibling writes after the first failure.
	await Promise.allSettled(
		interruptedByProject.map(async (entry) => {
			if (!persistenceAllowed()) return;
			try {
				await persistInterruptedSessions(entry.projectPath, entry.interruptedTaskIds, {
					projectState: entry.projectState,
					resolveSummary: entry.resolveSummary,
				});
			} catch (error) {
				recordFailure(
					"persistence_failed",
					`Could not persist interrupted sessions for ${entry.projectPath}. ${String(error)}`,
				);
			}
		}),
	);
}

function shutdownOutcome(reasons: Set<RuntimeShutdownIncompleteReason>): RuntimeShutdownOutcome {
	return reasons.size === 0
		? { status: "clean", safeToExit: true, safeToReleaseOwnership: true }
		: { status: "incomplete", safeToExit: false, safeToReleaseOwnership: false, reasons: Array.from(reasons) };
}

export async function shutdownRuntimeServer(
	deps: RuntimeShutdownCoordinatorDependencies,
): Promise<RuntimeShutdownResult> {
	const reasons = new Set<RuntimeShutdownIncompleteReason>();
	const recordFailure = (reason: RuntimeShutdownIncompleteReason, message: string) => {
		reasons.add(reason);
		deps.warn(message);
	};
	const checkOwnership = () => {
		const allowed = deps.persistenceAllowed?.() ?? true;
		if (!allowed) reasons.add("ownership_lost");
		return allowed;
	};
	const timeoutMs = deps.cleanupTimeoutMs ?? 7_000;
	let deadlineTimer: ReturnType<typeof setTimeout> | undefined;
	const deadline = new Promise<RuntimeShutdownOutcome>((resolve) => {
		deadlineTimer = setTimeout(() => {
			checkOwnership();
			deps.warn(`Shutdown cleanup timed out after ${timeoutMs}ms. Ownership remains held until cleanup settles.`);
			resolve(shutdownOutcome(new Set([...reasons, "deadline"])));
		}, timeoutMs);
	});
	let managedProjects: ReturnType<ProjectRegistry["listManagedProjects"]> = [];
	const interruptedSummaries = new Map<TerminalSessionManager, RuntimeTaskSessionSummary[]>();
	const quiescence: Promise<void>[] = [];
	let sessionsStopped = false;
	const stopSessions = () => {
		if (sessionsStopped) return;
		sessionsStopped = true;
		for (const { terminalManager } of managedProjects) {
			try {
				terminalManager.stopReconciliation();
				if (!deps.skipSessionCleanup) {
					interruptedSummaries.set(terminalManager, terminalManager.markInterruptedAndStopAll());
					quiescence.push(
						terminalManager.waitForShutdownQuiescence().catch((error) => {
							recordFailure(
								"quiescence_failed",
								`Managed session shutdown preparation failed. ${String(error)}`,
							);
						}),
					);
				}
			} catch (error) {
				recordFailure("quiescence_failed", `Could not stop managed sessions during shutdown. ${String(error)}`);
			}
		}
	};
	const preparation = (async () => {
		try {
			deps.projectRegistry.stopMaintenance?.();
			await deps.prepareForShutdown?.();
		} catch (error) {
			recordFailure("quiescence_failed", `Could not prepare runtime shutdown. ${String(error)}`);
		}
	})();
	const ownedProcesses = (async () => {
		await preparation;
		// A producer admitted before ingress closed may register a manager or
		// spawn a helper while draining. Snapshot the settled set, never an
		// enumeration captured concurrently with that drain.
		try {
			managedProjects = deps.projectRegistry.listManagedProjects();
			deps.beforeProcessSnapshot?.();
		} catch (error) {
			recordFailure("quiescence_failed", `Could not fence runtime process launches. ${String(error)}`);
		}
		if (deps.skipSessionCleanup) return;
		try {
			const attempt = deps.stopOwnedProcesses?.(stopSessions);
			if (!attempt) stopSessions();
			const result = await attempt;
			if (result?.status === "unconfirmed" || (!result && managedProjects.length > 0)) {
				recordFailure(
					"processes_unconfirmed",
					"Shutdown could not confirm termination of all owned process trees.",
				);
			}
		} catch (error) {
			recordFailure("processes_unconfirmed", `Owned process shutdown failed. ${String(error)}`);
		} finally {
			stopSessions();
		}
	})();
	const cleanup = (async () => {
		await ownedProcesses;
		if (deps.skipSessionCleanup) stopSessions();
		await Promise.all(quiescence);
		if (deps.skipSessionCleanup) {
			reasons.add("session_cleanup_skipped");
			return;
		}
		if (!checkOwnership() || reasons.has("quiescence_failed")) return;
		await persistShutdownSessions(deps, managedProjects, interruptedSummaries, recordFailure);
		checkOwnership();
	})().catch((error) => {
		recordFailure("persistence_failed", `Runtime shutdown cleanup failed. ${String(error)}`);
	});
	// Preparation fences ingress synchronously. A deadline reports incomplete
	// while cleanup continues; it must never trigger owner signals before the
	// admitted producer drain and exact process snapshot have completed.
	const close = (async () => {
		await cleanup;
		try {
			await deps.closeRuntimeServer();
		} catch (error) {
			recordFailure("server_close_failed", `Runtime server close failed. ${String(error)}`);
		}
	})();
	const completion = (async () => {
		await Promise.allSettled([cleanup, ownedProcesses, close]);
		checkOwnership();
		if (deadlineTimer !== undefined) clearTimeout(deadlineTimer);
		return shutdownOutcome(reasons);
	})();
	return { outcome: await Promise.race([completion, deadline]), completion };
}
