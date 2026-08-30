import { homedir } from "node:os";
import { join } from "node:path";

import { isWindowsSafePathComponent } from "./workdir-path-policy";

const WORKTREE_TASK_ID_INVALID_MESSAGE = "Invalid task id for worktree path.";

export const QUARTERDECK_RUNTIME_HOME_DIR_NAME = ".quarterdeck";
export const QUARTERDECK_TASK_WORKTREES_HOME_DIR_NAME = ".quarterdeck/worktrees";
export const QUARTERDECK_TASK_WORKTREES_DIR_NAME = "worktrees";
export const QUARTERDECK_TASK_WORKTREES_DISPLAY_ROOT =
	process.platform === "win32"
		? join(homedir(), QUARTERDECK_TASK_WORKTREES_HOME_DIR_NAME)
		: `~/${QUARTERDECK_TASK_WORKTREES_HOME_DIR_NAME}`;

export function normalizeTaskIdForWorktreePath(taskId: string, platform: NodeJS.Platform = process.platform): string {
	const normalized = taskId.trim();
	if (
		!normalized ||
		normalized.includes("/") ||
		normalized.includes("\\") ||
		normalized.includes("..") ||
		(platform === "win32" && (!isWindowsSafePathComponent(taskId) || !isWindowsSafePathComponent(normalized)))
	) {
		throw new Error(WORKTREE_TASK_ID_INVALID_MESSAGE);
	}
	return normalized;
}

export function getWorkdirFolderLabelForWorktreePath(
	repoPath: string,
	platform: NodeJS.Platform = process.platform,
): string {
	const withoutTrailingSeparators = repoPath.replace(/[\\/]+$/g, "");
	const folder =
		withoutTrailingSeparators
			.split(/[\\/]/g)
			.filter((segment) => segment.length > 0)
			.at(-1) ?? "project";
	const cleaned = [...folder]
		.filter((char) => {
			const code = char.charCodeAt(0);
			return code >= 32 && code !== 127;
		})
		.join("");
	return !cleaned ||
		cleaned === "." ||
		cleaned === ".." ||
		(platform === "win32" && !isWindowsSafePathComponent(cleaned))
		? "project"
		: cleaned;
}

export function buildTaskWorktreeDisplayPath(taskId: string, repoPath: string): string {
	const normalizedTaskId = normalizeTaskIdForWorktreePath(taskId);
	const projectLabel = getWorkdirFolderLabelForWorktreePath(repoPath);
	return join(QUARTERDECK_TASK_WORKTREES_DISPLAY_ROOT, normalizedTaskId, projectLabel);
}
