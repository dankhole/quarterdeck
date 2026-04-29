/**
 * Project orphan-maintenance boundary.
 *
 * Cleanup taxonomy:
 * - Session drift: live task summary vs PTY/PID state. Owned by
 *   `src/terminal/session-reconciliation*.ts` on the reconciliation timer.
 * - Process artifacts: orphaned agent processes from crashed Quarterdeck
 *   instances. Owned by `src/terminal/orphan-cleanup.ts` at startup/shutdown.
 * - Filesystem locks: stale Quarterdeck locks and git `index.lock` artifacts.
 *   Owned by `src/fs/lock-cleanup.ts`; this module schedules the periodic
 *   project-level git lock sweep.
 * - Orphan worktrees: task worktrees no longer referenced by active task flows.
 *   Owned by explicit task/project removal paths in workdir/project APIs.
 * - Dangling state references: persisted or broadcast session summaries whose
 *   cards no longer exist. Owned by state prune helpers at startup, shutdown,
 *   save, and broadcast boundaries.
 *
 * Keep this module as a scheduler/owner boundary, not a mega-cleanup loop. Add
 * new artifact cleanup to the owning subsystem above, then call it from a
 * named maintenance sweep only when it needs periodic project-level coverage.
 */
import { createTaggedLogger } from "../core";
import { cleanStaleGitIndexLocks } from "../fs";

const maintenanceLog = createTaggedLogger("project-orphan-maintenance");

export const PROJECT_ORPHAN_MAINTENANCE_INTERVAL_MS = 10_000;

export const PROJECT_ORPHAN_MAINTENANCE_TAXONOMY = [
	{
		className: "session_drift",
		owner: "src/terminal/session-reconciliation*.ts",
		schedule: "session reconciliation timer",
	},
	{
		className: "process_artifacts",
		owner: "src/terminal/orphan-cleanup.ts",
		schedule: "startup and shutdown",
	},
	{
		className: "filesystem_locks",
		owner: "src/fs/lock-cleanup.ts",
		schedule: "startup plus project orphan-maintenance timer",
	},
	{
		className: "orphan_worktrees",
		owner: "src/workdir/task-worktree-lifecycle.ts and project removal flows",
		schedule: "explicit task/project removal",
	},
	{
		className: "dangling_state_references",
		owner: "src/state/project-state.ts and broadcast prune helpers",
		schedule: "startup, shutdown, save, and broadcast boundaries",
	},
] as const;

type WarnFn = (message: string) => void;
type CleanStaleGitIndexLocks = (projectRepoPaths: string[], warn?: WarnFn) => Promise<void>;

export interface ProjectOrphanMaintenanceSweepContext {
	getProjectRepoPaths: () => Iterable<string | null | undefined>;
	cleanStaleGitIndexLocks?: CleanStaleGitIndexLocks;
	warn?: WarnFn;
}

export interface ProjectOrphanMaintenanceTimer {
	start(): void;
	stop(): void;
	runNow(): Promise<void>;
}

function collectProjectRepoPaths(paths: Iterable<string | null | undefined>): string[] {
	const uniquePaths = new Set<string>();
	for (const path of paths) {
		if (!path) {
			continue;
		}
		uniquePaths.add(path);
	}
	return Array.from(uniquePaths);
}

export async function runProjectOrphanMaintenanceSweep(ctx: ProjectOrphanMaintenanceSweepContext): Promise<void> {
	const projectRepoPaths = collectProjectRepoPaths(ctx.getProjectRepoPaths());
	if (projectRepoPaths.length === 0) {
		return;
	}
	await (ctx.cleanStaleGitIndexLocks ?? cleanStaleGitIndexLocks)(projectRepoPaths, ctx.warn);
}

export function createProjectOrphanMaintenanceTimer(
	ctx: ProjectOrphanMaintenanceSweepContext,
	intervalMs: number = PROJECT_ORPHAN_MAINTENANCE_INTERVAL_MS,
): ProjectOrphanMaintenanceTimer {
	let timer: NodeJS.Timeout | null = null;
	let runningSweep: Promise<void> | null = null;

	const runNow = (): Promise<void> => {
		if (runningSweep) {
			return runningSweep;
		}
		runningSweep = runProjectOrphanMaintenanceSweep(ctx)
			.catch((error) => {
				maintenanceLog.error("project orphan maintenance sweep failed", {
					error: error instanceof Error ? error.message : String(error),
				});
			})
			.finally(() => {
				runningSweep = null;
			});
		return runningSweep;
	};

	return {
		start() {
			if (timer) {
				return;
			}
			timer = setInterval(() => {
				void runNow();
			}, intervalMs);
			timer.unref();
		},
		stop() {
			if (timer) {
				clearInterval(timer);
				timer = null;
			}
		},
		runNow,
	};
}
