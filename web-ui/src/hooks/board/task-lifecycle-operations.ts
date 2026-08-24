import type { RuntimeTaskLifecycleCommand, RuntimeTaskLifecycleOutcomeCode } from "@/runtime/types";

export type TaskLifecycleCommandDraft = RuntimeTaskLifecycleCommand extends infer Command
	? Command extends RuntimeTaskLifecycleCommand
		? Omit<Command, "operationId" | "expectedRevision">
		: never
	: never;

export function createTaskLifecycleOperationId(kind: RuntimeTaskLifecycleCommand["kind"]): string {
	const suffix =
		typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
			? crypto.randomUUID()
			: `${Date.now().toString(36)}:${Math.random().toString(36).slice(2)}`;
	return `lifecycle:${kind}:${suffix}`;
}

export function createTaskLifecycleScopeKey(projectId: string, taskId: string): string {
	return JSON.stringify([projectId, taskId]);
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

export function getTaskLifecyclePendingLabel(kind: RuntimeTaskLifecycleCommand["kind"]): string {
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
