import type {
	RuntimeAutoMergedFilesResponse,
	RuntimeConflictAbortResponse,
	RuntimeConflictContinueResponse,
	RuntimeConflictFilesResponse,
} from "../core/api-contract";
import {
	abortMergeOrRebase,
	continueMergeOrRebase,
	getAutoMergedFileContent,
	getConflictFileContent,
	resolveConflictFile as gitResolveConflictFile,
} from "../workspace/git-conflict";
import type { RuntimeTrpcContext } from "./app-router-context";
import { EMPTY_GIT_SUMMARY, errorMessage, resolveWorkingDir, type WorkspaceApiContext } from "./workspace-api-shared";

type ConflictOps = Pick<
	RuntimeTrpcContext["workspaceApi"],
	| "getConflictFiles"
	| "getAutoMergedFiles"
	| "resolveConflictFile"
	| "continueConflictResolution"
	| "abortConflictResolution"
>;

export function createConflictOps(ctx: WorkspaceApiContext): ConflictOps {
	return {
		getConflictFiles: async (workspaceScope, input) => {
			try {
				const cwd = await resolveWorkingDir(
					workspaceScope.workspacePath,
					input.taskId ? { taskId: input.taskId, baseRef: "" } : null,
				);
				const files = await Promise.all(input.paths.map((path) => getConflictFileContent(cwd, path)));
				return { ok: true, files } satisfies RuntimeConflictFilesResponse;
			} catch (error) {
				return { ok: false, files: [], error: errorMessage(error) } satisfies RuntimeConflictFilesResponse;
			}
		},

		getAutoMergedFiles: async (workspaceScope, input) => {
			try {
				const cwd = await resolveWorkingDir(
					workspaceScope.workspacePath,
					input.taskId ? { taskId: input.taskId, baseRef: "" } : null,
				);
				const files = await Promise.all(input.paths.map((path) => getAutoMergedFileContent(cwd, path)));
				return { ok: true, files } satisfies RuntimeAutoMergedFilesResponse;
			} catch (error) {
				return { ok: false, files: [], error: errorMessage(error) } satisfies RuntimeAutoMergedFilesResponse;
			}
		},

		resolveConflictFile: async (workspaceScope, input) => {
			try {
				const cwd = await resolveWorkingDir(
					workspaceScope.workspacePath,
					input.taskId ? { taskId: input.taskId, baseRef: "" } : null,
				);
				const result = await gitResolveConflictFile(cwd, input.path, input.resolution);
				if (result.ok) ctx.broadcastStateUpdate(workspaceScope);
				return result;
			} catch (error) {
				return { ok: false, error: errorMessage(error) };
			}
		},

		continueConflictResolution: async (workspaceScope, input) => {
			try {
				const cwd = await resolveWorkingDir(
					workspaceScope.workspacePath,
					input.taskId ? { taskId: input.taskId, baseRef: "" } : null,
				);
				const response = await continueMergeOrRebase(cwd);
				ctx.broadcastStateUpdate(workspaceScope);
				return response;
			} catch (error) {
				return {
					ok: false,
					completed: false,
					summary: { ...EMPTY_GIT_SUMMARY },
					output: "",
					error: errorMessage(error),
				} satisfies RuntimeConflictContinueResponse;
			}
		},

		abortConflictResolution: async (workspaceScope, input) => {
			try {
				const cwd = await resolveWorkingDir(
					workspaceScope.workspacePath,
					input.taskId ? { taskId: input.taskId, baseRef: "" } : null,
				);
				const response = await abortMergeOrRebase(cwd);
				ctx.broadcastStateUpdate(workspaceScope);
				return response;
			} catch (error) {
				return {
					ok: false,
					summary: { ...EMPTY_GIT_SUMMARY },
					error: errorMessage(error),
				} satisfies RuntimeConflictAbortResponse;
			}
		},
	};
}
