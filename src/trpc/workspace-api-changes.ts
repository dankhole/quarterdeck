import { TRPCError } from "@trpc/server";
import type { RuntimeFileContentResponse, RuntimeListFilesResponse, RuntimeWorkspaceFileSearchResponse } from "../core";
import {
	assertValidGitRef,
	createEmptyWorkspaceChangesResponse,
	getCommitDiff,
	getFileContentAtRef,
	getGitLog,
	getGitRefs,
	getGitStdout,
	getWorkspaceChanges,
	getWorkspaceChangesBetweenRefs,
	getWorkspaceChangesFromRef,
	getWorkspaceFileDiff,
	listAllWorkspaceFiles,
	listFilesAtRef,
	readWorkspaceFile,
	searchWorkspaceFiles,
	validateGitPath,
} from "../workspace";
import type { RuntimeTrpcContext } from "./app-router-context";
import {
	normalizeOptionalTaskWorkspaceScopeInput,
	normalizeRequiredTaskWorkspaceScopeInput,
	resolveWorkingDir,
	tryResolveTaskCwd,
	type WorkspaceApiContext,
} from "./workspace-api-shared";

type ChangesOps = Pick<
	RuntimeTrpcContext["workspaceApi"],
	| "loadChanges"
	| "loadFileDiff"
	| "getDiffText"
	| "loadWorkspaceChanges"
	| "loadGitLog"
	| "loadGitRefs"
	| "loadCommitDiff"
	| "searchFiles"
	| "listFiles"
	| "getFileContent"
>;

export function createChangesOps(ctx: WorkspaceApiContext): ChangesOps {
	return {
		loadChanges: async (workspaceScope, input) => {
			const threeDot = input.diffMode === "three_dot";

			if (input.fromRef) {
				assertValidGitRef(input.fromRef, "fromRef");
				if (input.toRef) assertValidGitRef(input.toRef, "toRef");

				let cwd = workspaceScope.workspacePath;
				if (input.taskId) {
					const resolved = await tryResolveTaskCwd(
						workspaceScope.workspacePath,
						input.taskId,
						input.baseRef ?? "",
					);
					if (!resolved) return await createEmptyWorkspaceChangesResponse(workspaceScope.workspacePath);
					cwd = resolved;
				}

				if (input.toRef) {
					return await getWorkspaceChangesBetweenRefs({
						cwd,
						fromRef: input.fromRef,
						toRef: input.toRef,
						threeDot,
					});
				}
				return await getWorkspaceChangesFromRef({ cwd, fromRef: input.fromRef, threeDot });
			}

			if (!input.taskId) {
				return await getWorkspaceChanges(workspaceScope.workspacePath);
			}

			const normalizedInput = normalizeRequiredTaskWorkspaceScopeInput(input);
			const taskCwd = await tryResolveTaskCwd(
				workspaceScope.workspacePath,
				normalizedInput.taskId,
				normalizedInput.baseRef,
			);
			if (!taskCwd) return await createEmptyWorkspaceChangesResponse(workspaceScope.workspacePath);

			if (normalizedInput.mode === "last_turn") {
				const terminalManager = await ctx.deps.terminals.ensureTerminalManagerForWorkspace(
					workspaceScope.workspaceId,
					workspaceScope.workspacePath,
				);
				const summary = terminalManager.store.getSummary(normalizedInput.taskId);
				const fromCheckpoint = summary?.previousTurnCheckpoint;
				const toCheckpoint = summary?.latestTurnCheckpoint;
				if (!toCheckpoint) {
					return await createEmptyWorkspaceChangesResponse(taskCwd);
				}
				if (summary?.state === "running" || !fromCheckpoint) {
					return await getWorkspaceChangesFromRef({
						cwd: taskCwd,
						fromRef: toCheckpoint.commit,
					});
				}
				return await getWorkspaceChangesBetweenRefs({
					cwd: taskCwd,
					fromRef: fromCheckpoint.commit,
					toRef: toCheckpoint.commit,
				});
			}
			return await getWorkspaceChanges(taskCwd);
		},

		loadFileDiff: async (workspaceScope, input) => {
			const emptyResult = { path: input.path, oldText: null, newText: null };
			const threeDot = input.diffMode === "three_dot";

			if (!validateGitPath(input.path)) {
				throw new TRPCError({ code: "BAD_REQUEST", message: "Invalid file path." });
			}
			if (input.previousPath && !validateGitPath(input.previousPath)) {
				throw new TRPCError({ code: "BAD_REQUEST", message: "Invalid previous path." });
			}

			if (input.fromRef) {
				assertValidGitRef(input.fromRef, "fromRef");
				if (input.toRef) assertValidGitRef(input.toRef, "toRef");

				let cwd = workspaceScope.workspacePath;
				if (input.taskId) {
					const resolved = await tryResolveTaskCwd(
						workspaceScope.workspacePath,
						input.taskId,
						input.baseRef ?? "",
					);
					if (!resolved) return emptyResult;
					cwd = resolved;
				}

				return await getWorkspaceFileDiff({
					cwd,
					path: input.path,
					previousPath: input.previousPath,
					status: input.status,
					fromRef: input.fromRef,
					toRef: input.toRef,
					threeDot,
				});
			}

			if (!input.taskId) {
				return await getWorkspaceFileDiff({
					cwd: workspaceScope.workspacePath,
					path: input.path,
					previousPath: input.previousPath,
					status: input.status,
				});
			}

			const normalizedInput = normalizeRequiredTaskWorkspaceScopeInput(input);
			const taskCwd = await tryResolveTaskCwd(
				workspaceScope.workspacePath,
				normalizedInput.taskId,
				normalizedInput.baseRef,
			);
			if (!taskCwd) return emptyResult;

			if (normalizedInput.mode === "last_turn") {
				const terminalManager = await ctx.deps.terminals.ensureTerminalManagerForWorkspace(
					workspaceScope.workspaceId,
					workspaceScope.workspacePath,
				);
				const summary = terminalManager.store.getSummary(normalizedInput.taskId);
				const fromCheckpoint = summary?.previousTurnCheckpoint;
				const toCheckpoint = summary?.latestTurnCheckpoint;
				if (!toCheckpoint) return emptyResult;

				return await getWorkspaceFileDiff({
					cwd: taskCwd,
					path: input.path,
					previousPath: input.previousPath,
					status: input.status,
					fromRef: summary?.state === "running" || !fromCheckpoint ? toCheckpoint.commit : fromCheckpoint.commit,
					toRef: summary?.state === "running" || !fromCheckpoint ? undefined : toCheckpoint.commit,
				});
			}

			return await getWorkspaceFileDiff({
				cwd: taskCwd,
				path: input.path,
				previousPath: input.previousPath,
				status: input.status,
			});
		},

		getDiffText: async (workspaceScope, taskScope, paths) => {
			const cwd = await resolveWorkingDir(workspaceScope.workspacePath, taskScope);
			const args = ["diff", "HEAD", "--"];
			if (paths && paths.length > 0) {
				args.push(...paths);
			}
			return await getGitStdout(args, cwd);
		},

		loadWorkspaceChanges: async (workspaceScope) => {
			return await getWorkspaceChanges(workspaceScope.workspacePath);
		},

		loadGitLog: async (workspaceScope, input) => {
			const cwd = await resolveWorkingDir(
				workspaceScope.workspacePath,
				normalizeOptionalTaskWorkspaceScopeInput(input.taskScope ?? null),
			);
			return await getGitLog({
				cwd,
				ref: input.ref ?? null,
				refs: input.refs ?? null,
				maxCount: input.maxCount,
				skip: input.skip,
			});
		},

		loadGitRefs: async (workspaceScope, input) => {
			const cwd = await resolveWorkingDir(
				workspaceScope.workspacePath,
				normalizeOptionalTaskWorkspaceScopeInput(input ?? null),
			);
			return await getGitRefs(cwd);
		},

		loadCommitDiff: async (workspaceScope, input) => {
			const cwd = await resolveWorkingDir(
				workspaceScope.workspacePath,
				normalizeOptionalTaskWorkspaceScopeInput(input.taskScope ?? null),
			);
			return await getCommitDiff({ cwd, commitHash: input.commitHash });
		},

		searchFiles: async (workspaceScope, input) => {
			const query = input.query.trim();
			const files = await searchWorkspaceFiles(workspaceScope.workspacePath, query, input.limit);
			return { query, files } satisfies RuntimeWorkspaceFileSearchResponse;
		},

		listFiles: async (workspaceScope, input) => {
			if (!input.taskId) {
				if (input.ref) {
					const files = await listFilesAtRef(workspaceScope.workspacePath, input.ref);
					return { files } satisfies RuntimeListFilesResponse;
				}
				const files = await listAllWorkspaceFiles(workspaceScope.workspacePath);
				return { files } satisfies RuntimeListFilesResponse;
			}

			const normalizedInput = normalizeRequiredTaskWorkspaceScopeInput(input);
			const taskCwd = await tryResolveTaskCwd(
				workspaceScope.workspacePath,
				normalizedInput.taskId,
				normalizedInput.baseRef,
			);
			if (!taskCwd) return { files: [] } satisfies RuntimeListFilesResponse;

			if (input.ref) {
				const files = await listFilesAtRef(taskCwd, input.ref);
				return { files } satisfies RuntimeListFilesResponse;
			}

			const files = await listAllWorkspaceFiles(taskCwd);
			return { files } satisfies RuntimeListFilesResponse;
		},

		getFileContent: async (workspaceScope, input) => {
			const filePath = input.path.trim();
			if (!filePath) throw new Error("Missing path parameter.");

			const EMPTY_FILE_RESPONSE = {
				content: "",
				language: "",
				binary: false,
				size: 0,
				truncated: false,
			} satisfies RuntimeFileContentResponse;

			let cwd: string | null;
			if (!input.taskId) {
				cwd = workspaceScope.workspacePath;
			} else {
				const normalizedInput = normalizeRequiredTaskWorkspaceScopeInput(input);
				cwd = await tryResolveTaskCwd(
					workspaceScope.workspacePath,
					normalizedInput.taskId,
					normalizedInput.baseRef,
				);
			}
			if (!cwd) return EMPTY_FILE_RESPONSE;

			if (input.ref) {
				const refContent = await getFileContentAtRef(cwd, input.ref, filePath);
				if (!refContent) return EMPTY_FILE_RESPONSE;
				return {
					content: refContent.content,
					language: "",
					binary: refContent.binary,
					size: refContent.content.length,
					truncated: false,
				} satisfies RuntimeFileContentResponse;
			}

			return await readWorkspaceFile(cwd, filePath);
		},
	};
}
