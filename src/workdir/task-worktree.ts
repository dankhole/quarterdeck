export { deleteTaskWorktree, ensureTaskWorktreeIfDoesntExist } from "./task-worktree-lifecycle";
export { applyTaskPatch, captureTaskPatch, findTaskPatch } from "./task-worktree-patch";
export {
	getTaskRepositoryInfo,
	getTaskWorkingDirectory,
	getTaskWorktreeInfo,
	getTaskWorktreePathInfo,
	isMissingTaskWorktreeError,
	resolveTaskCwd,
	resolveTaskWorkingDirectory,
} from "./task-worktree-resolve";
export { mirrorIgnoredPath, pathExists } from "./task-worktree-symlinks";
