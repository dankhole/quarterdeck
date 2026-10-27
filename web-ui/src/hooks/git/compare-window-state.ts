import type { RuntimeProjectMetadata, RuntimeProjectSummary } from "@/runtime/types";
import type { BoardCard, BoardData } from "@/types";
import type { CompareWindowTarget } from "../../../../src/shared/compare-window-contract";

export type CompareWindowContext =
	| { readonly status: "loading" }
	| { readonly status: "error"; readonly message: string }
	| {
			readonly status: "ready";
			readonly project: RuntimeProjectSummary;
			readonly task: BoardCard | null;
			readonly rootPath: string;
			readonly baseRef: string | null;
			readonly branch: string | null;
	  };

/** Resolve only the captured identity. Never substitute the stream's default project or home. */
export function resolveCompareWindowContext(input: {
	target: CompareWindowTarget;
	currentProjectId: string | null;
	projects: readonly RuntimeProjectSummary[];
	board: BoardData | null;
	metadata: RuntimeProjectMetadata | null;
	hasReceivedSnapshot: boolean;
	streamError: string | null;
	isRuntimeDisconnected: boolean;
}): CompareWindowContext {
	if (input.streamError || input.isRuntimeDisconnected) {
		return {
			status: "error",
			message: input.streamError ?? "The runtime is disconnected. Reconnect to continue reviewing.",
		};
	}
	if (!input.hasReceivedSnapshot) return { status: "loading" };
	const project = input.projects.find((candidate) => candidate.id === input.target.projectId);
	if (!project || input.currentProjectId !== input.target.projectId) {
		return { status: "error", message: "The project captured by this Compare window is no longer available." };
	}
	if (project.availability?.status === "unavailable" || project.folderOnly) {
		return {
			status: "error",
			message: "The captured project repository is unavailable. Restore its folder to continue reviewing.",
		};
	}
	if (!input.board) return { status: "loading" };
	if (input.target.taskId === null) {
		return { status: "ready", project, task: null, rootPath: project.path, baseRef: null, branch: null };
	}
	const column = input.board.columns.find((candidate) =>
		candidate.cards.some((task) => task.id === input.target.taskId),
	);
	const task = column?.cards.find((candidate) => candidate.id === input.target.taskId);
	if (!task || task.createdAt !== input.target.taskCreatedAt) {
		return { status: "error", message: "The task captured by this Compare window was removed or replaced." };
	}
	if (column?.id === "trash") {
		return {
			status: "error",
			message: "The task captured by this Compare window is in Trash. Restore it to continue reviewing.",
		};
	}
	if (!input.metadata) return { status: "loading" };
	const worktree = input.metadata.taskWorktrees.find((candidate) => candidate.taskId === task.id);
	if (!worktree?.exists || !worktree.path) {
		return {
			status: "error",
			message:
				"The captured task's workspace is unavailable. This window will not fall back to the home repository.",
		};
	}
	return { status: "ready", project, task, rootPath: worktree.path, baseRef: task.baseRef, branch: worktree.branch };
}
