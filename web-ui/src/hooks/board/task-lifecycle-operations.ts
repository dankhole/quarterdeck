import type {
	RuntimeTaskLifecycleCommand,
	RuntimeTaskLifecycleOperationPhase,
	RuntimeTaskLifecycleOutcomeCode,
} from "@/runtime/types";
import { createRandomId } from "@/utils/random-id";

export type TaskLifecycleCommandDraft = RuntimeTaskLifecycleCommand extends infer Command
	? Command extends RuntimeTaskLifecycleCommand
		? Omit<Command, "operationId" | "expectedRevision">
		: never
	: never;

export function createTaskLifecycleOperationId(kind: RuntimeTaskLifecycleCommand["kind"]): string {
	return createRandomId(`lifecycle:${kind}`);
}

export function createTaskLifecycleScopeKey(projectId: string, taskId: string): string {
	return JSON.stringify([projectId, taskId]);
}

/** Bounded wait for the project's first authoritative revision, used by
 * lifecycle actions and Clear Trash. See docs/conventions/runtime-state.md
 * (Authoritative browser hydration). */
export const AUTHORITATIVE_REVISION_WAIT_TIMEOUT_MS = 15_000;
const AUTHORITATIVE_REVISION_POLL_INTERVAL_MS = 250;

/**
 * Poll for the project's first authoritative revision instead of failing an
 * action the instant it races project hydration (e.g. right after switching
 * to, or reloading on, a project that has not hydrated yet). Bounded so a
 * project genuinely stuck unavailable does not block the action forever —
 * the caller's existing "still loading" message covers an exhausted wait.
 */
export async function waitForAuthoritativeRevision(
	getAuthoritativeRevision: () => number | null,
	timeoutMs: number = AUTHORITATIVE_REVISION_WAIT_TIMEOUT_MS,
): Promise<number | null> {
	const immediate = getAuthoritativeRevision();
	if (immediate !== null) {
		return immediate;
	}
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		await new Promise<void>((resolve) => setTimeout(resolve, AUTHORITATIVE_REVISION_POLL_INTERVAL_MS));
		const revision = getAuthoritativeRevision();
		if (revision !== null) {
			return revision;
		}
	}
	return null;
}

export function getTaskLifecycleFailureMessage(
	outcome: RuntimeTaskLifecycleOutcomeCode | null,
	fallback?: string,
): string {
	switch (outcome) {
		case "busy":
			return "Another action is already running for this task.";
		case "identity_conflict":
			return "This task action could not be safely retried. Try the action again.";
		case "stale_task":
			return "The task changed before this action completed. The board has been refreshed.";
		case "invalid_transition":
		case "revision_conflict":
			return "The task moved elsewhere before this action completed. The board has been refreshed.";
		case "stop_timed_out":
			return "The agent did not stop in time. No workspace cleanup was performed.";
		case "stop_failed":
			return "Quarterdeck could not stop the agent. No workspace cleanup was performed.";
		case "worktree_failed":
			return fallback ?? "Quarterdeck could not finish the task workspace change.";
		case "session_start_failed":
			return fallback ?? "Quarterdeck could not start the agent session.";
		case "compensation_failed":
			return "The action failed and Quarterdeck could not safely restore the previous task state. Check runtime logs.";
		case "superseded":
			return fallback ?? "A newer task action replaced this one.";
		default:
			return fallback ?? "Quarterdeck could not complete the task action.";
	}
}

export function getTaskLifecyclePendingLabel(
	kind: RuntimeTaskLifecycleCommand["kind"],
	phase?: RuntimeTaskLifecycleOperationPhase,
): string {
	if (phase === "running_setup") return "Running worktree setup script";
	if (phase === "ensuring_worktree") return "Preparing worktree";
	switch (kind) {
		case "start":
		case "create_and_start":
			return "Starting agent";
		case "trash":
			return "Moving to Trash";
		case "restore":
			return "Restoring task";
		case "stop":
			return "Stopping agent";
		case "restart":
			return "Restarting agent";
		case "delete":
			return "Deleting task";
	}
}
