import type {
	RuntimeAutoMergedFilesResponse,
	RuntimeConflictAbortResponse,
	RuntimeConflictContinueResponse,
	RuntimeConflictFilesResponse,
} from "../core";
import {
	abortMergeOrRebase,
	continueMergeOrRebase,
	getAutoMergedFileContent,
	getConflictFileContent,
	resolveConflictFile as gitResolveConflictFile,
} from "../workdir";
import type { RuntimeTrpcContext } from "./app-router-context";
import { EMPTY_GIT_SUMMARY, errorMessage, type ProjectApiContext, resolveWorkingDir } from "./project-api-shared";

type ConflictOps = Pick<
	RuntimeTrpcContext["projectApi"],
	| "getConflictFiles"
	| "getAutoMergedFiles"
	| "resolveConflictFile"
	| "continueConflictResolution"
	| "abortConflictResolution"
>;

export function createConflictOps(ctx: ProjectApiContext): ConflictOps {
	return {
		getConflictFiles: async (projectScope, input) => {
			try {
				const cwd = await resolveWorkingDir(
					projectScope.projectPath,
					input.taskId ? { taskId: input.taskId, baseRef: "" } : null,
				);
				const files = await Promise.all(input.paths.map((path) => getConflictFileContent(cwd, path)));
				return { ok: true, files } satisfies RuntimeConflictFilesResponse;
			} catch (error) {
				return { ok: false, files: [], error: errorMessage(error) } satisfies RuntimeConflictFilesResponse;
			}
		},

		getAutoMergedFiles: async (projectScope, input) => {
			try {
				const cwd = await resolveWorkingDir(
					projectScope.projectPath,
					input.taskId ? { taskId: input.taskId, baseRef: "" } : null,
				);
				const files = await Promise.all(input.paths.map((path) => getAutoMergedFileContent(cwd, path)));
				return { ok: true, files } satisfies RuntimeAutoMergedFilesResponse;
			} catch (error) {
				return { ok: false, files: [], error: errorMessage(error) } satisfies RuntimeAutoMergedFilesResponse;
			}
		},

		resolveConflictFile: async (projectScope, input) => {
			try {
				const cwd = await resolveWorkingDir(
					projectScope.projectPath,
					input.taskId ? { taskId: input.taskId, baseRef: "" } : null,
				);
				const result = await gitResolveConflictFile(cwd, input.path, input.resolution);
				if (result.ok) ctx.broadcastStateUpdate(projectScope);
				return result;
			} catch (error) {
				return { ok: false, error: errorMessage(error) };
			}
		},

		continueConflictResolution: async (projectScope, input) => {
			try {
				const cwd = await resolveWorkingDir(
					projectScope.projectPath,
					input.taskId ? { taskId: input.taskId, baseRef: "" } : null,
				);
				const response = await continueMergeOrRebase(cwd);
				ctx.broadcastStateUpdate(projectScope);
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

		abortConflictResolution: async (projectScope, input) => {
			try {
				const cwd = await resolveWorkingDir(
					projectScope.projectPath,
					input.taskId ? { taskId: input.taskId, baseRef: "" } : null,
				);
				const response = await abortMergeOrRebase(cwd);
				ctx.broadcastStateUpdate(projectScope);
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
