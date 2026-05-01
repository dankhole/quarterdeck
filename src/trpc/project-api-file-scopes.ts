import type { RuntimeFileContentResponse, RuntimeListFilesResponse, RuntimeWorkdirSearchScope } from "../core";
import { resolveWorkingDir, tryResolveTaskCwd } from "./project-api-shared";

export interface ProjectFileScopeInput {
	taskId?: string | null;
	baseRef?: string;
	ref?: string;
}

export interface ResolvedProjectFileScope {
	readonly cwd: string | null;
	readonly ref: string | null;
	readonly mutable: boolean;
	readonly mutationBlockedReason?: string;
}

export const EMPTY_FILE_CONTENT_RESPONSE = {
	content: "",
	language: "",
	binary: false,
	size: 0,
	truncated: false,
} satisfies RuntimeFileContentResponse;

export function createUnavailableFileListResponse(reason: string): RuntimeListFilesResponse {
	return {
		files: [],
		directories: [],
		mutable: false,
		mutationBlockedReason: reason,
	};
}

export async function resolveProjectFileScope(
	projectPath: string,
	input: ProjectFileScopeInput,
): Promise<ResolvedProjectFileScope> {
	const ref = input.ref || null;
	if (!input.taskId) {
		return {
			cwd: projectPath,
			ref,
			mutable: ref === null,
			...(ref ? { mutationBlockedReason: "Branch/ref browsing is read-only." } : {}),
		};
	}

	const taskId = input.taskId.trim();
	if (!taskId) throw new Error("Missing taskId query parameter.");
	const cwd = await tryResolveTaskCwd(projectPath, taskId, input.baseRef?.trim() ?? "");
	if (!cwd) {
		return {
			cwd: null,
			ref,
			mutable: false,
			mutationBlockedReason: "Worktree is unavailable.",
		};
	}
	return {
		cwd,
		ref,
		mutable: ref === null,
		...(ref ? { mutationBlockedReason: "Branch/ref browsing is read-only." } : {}),
	};
}

export async function resolveProjectFileCwd(
	projectPath: string,
	input: RuntimeWorkdirSearchScope,
): Promise<string | null> {
	if (!input.taskId) {
		return projectPath;
	}
	const taskId = input.taskId.trim();
	if (!taskId) throw new Error("Missing taskId query parameter.");
	return await tryResolveTaskCwd(projectPath, taskId, input.baseRef?.trim() ?? "");
}

export async function resolveMutableWorkdirEntryCwd(
	projectPath: string,
	input: { taskId: string | null; baseRef?: string },
): Promise<string> {
	if (!input.taskId) {
		return projectPath;
	}
	const taskId = input.taskId.trim();
	if (!taskId) throw new Error("Missing taskId query parameter.");
	return await resolveWorkingDir(projectPath, { taskId, baseRef: input.baseRef?.trim() ?? "" });
}
