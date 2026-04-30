import { TRPCError } from "@trpc/server";
import type {
	RuntimeFileContentResponse,
	RuntimeListFilesResponse,
	RuntimeWorkdirFileChange,
	RuntimeWorkdirFileSearchResponse,
	RuntimeWorkdirTextSearchResponse,
} from "../core";
import type { RuntimeCommitMessageGenerationContext } from "../title";
import {
	assertValidGitRef,
	createEmptyWorkdirChangesResponse,
	GIT_INSPECTION_OPTIONS,
	getCommitDiff,
	getFileContentAtRef,
	getGitLog,
	getGitRefs,
	getGitStdout,
	getWorkdirChanges,
	getWorkdirChangesBetweenRefs,
	getWorkdirChangesForPaths,
	getWorkdirChangesFromRef,
	getWorkdirFileDiff,
	listAllWorkdirFiles,
	listFilesAtRef,
	readWorkdirFile,
	readWorkdirFileExcerpt,
	searchWorkdirFiles,
	searchWorkdirText,
	validateGitPath,
} from "../workdir";
import type { RuntimeTrpcContext } from "./app-router-context";
import {
	normalizeOptionalTaskScopeInput,
	normalizeRequiredTaskScopeInput,
	type ProjectApiContext,
	resolveWorkingDir,
	tryResolveTaskCwd,
} from "./project-api-shared";

type ChangesOps = Pick<
	RuntimeTrpcContext["projectApi"],
	| "loadChanges"
	| "loadFileDiff"
	| "getCommitMessageContext"
	| "loadWorkdirChanges"
	| "loadGitLog"
	| "loadGitRefs"
	| "loadCommitDiff"
	| "searchFiles"
	| "searchText"
	| "listFiles"
	| "getFileContent"
>;

const MAX_UNTRACKED_CONTENT_FILES = 12;
const MAX_UNTRACKED_FILE_CONTENT_LENGTH = 4_000;

function toCommitMessageFileContext(file: RuntimeWorkdirFileChange) {
	return {
		path: file.path,
		...(file.previousPath ? { previousPath: file.previousPath } : {}),
		status: file.status,
		additions: file.additions,
		deletions: file.deletions,
	};
}

function selectCommitMessageFiles(files: RuntimeWorkdirFileChange[], paths: string[] | undefined) {
	if (!paths || paths.length === 0) {
		return files.map(toCommitMessageFileContext);
	}

	const fileByPath = new Map(files.map((file) => [file.path, file]));
	return paths.flatMap((path) => {
		const file = fileByPath.get(path);
		return file ? [toCommitMessageFileContext(file)] : [];
	});
}

async function loadUntrackedFileContents(
	cwd: string,
	files: RuntimeCommitMessageGenerationContext["files"],
): Promise<Pick<RuntimeCommitMessageGenerationContext, "untrackedFileContents" | "untrackedContentOmittedCount">> {
	const untrackedFiles = files.filter((file) => file.status === "untracked");
	const filesWithContent = untrackedFiles.slice(0, MAX_UNTRACKED_CONTENT_FILES);
	const entries = await Promise.all(
		filesWithContent.map(async (file) => {
			try {
				const excerpt = await readWorkdirFileExcerpt(cwd, file.path, MAX_UNTRACKED_FILE_CONTENT_LENGTH);
				return {
					path: file.path,
					content: excerpt.content,
					truncated: excerpt.truncated,
					...(excerpt.omittedReason ? { omittedReason: excerpt.omittedReason } : {}),
				};
			} catch {
				return {
					path: file.path,
					content: "",
					truncated: false,
					omittedReason: "unreadable" as const,
				};
			}
		}),
	);
	return {
		untrackedFileContents: entries.filter((entry) => entry !== null),
		untrackedContentOmittedCount: Math.max(0, untrackedFiles.length - filesWithContent.length),
	};
}

export function createChangesOps(ctx: ProjectApiContext): ChangesOps {
	return {
		loadChanges: async (projectScope, input) => {
			const threeDot = input.diffMode === "three_dot";

			if (input.fromRef) {
				assertValidGitRef(input.fromRef, "fromRef");
				if (input.toRef) assertValidGitRef(input.toRef, "toRef");

				let cwd = projectScope.projectPath;
				if (input.taskId) {
					const resolved = await tryResolveTaskCwd(projectScope.projectPath, input.taskId, input.baseRef ?? "");
					if (!resolved) return await createEmptyWorkdirChangesResponse(projectScope.projectPath);
					cwd = resolved;
				}

				if (input.toRef) {
					return await getWorkdirChangesBetweenRefs({
						cwd,
						fromRef: input.fromRef,
						toRef: input.toRef,
						threeDot,
					});
				}
				return await getWorkdirChangesFromRef({ cwd, fromRef: input.fromRef, threeDot });
			}

			if (!input.taskId) {
				return await getWorkdirChanges(projectScope.projectPath);
			}

			const normalizedInput = normalizeRequiredTaskScopeInput(input);
			const taskCwd = await tryResolveTaskCwd(
				projectScope.projectPath,
				normalizedInput.taskId,
				normalizedInput.baseRef,
			);
			if (!taskCwd) return await createEmptyWorkdirChangesResponse(projectScope.projectPath);

			if (normalizedInput.mode === "last_turn") {
				const terminalManager = await ctx.deps.terminals.ensureTerminalManagerForProject(
					projectScope.projectId,
					projectScope.projectPath,
				);
				const summary = terminalManager.store.getSummary(normalizedInput.taskId);
				const fromCheckpoint = summary?.previousTurnCheckpoint;
				const toCheckpoint = summary?.latestTurnCheckpoint;
				if (!toCheckpoint) {
					return await createEmptyWorkdirChangesResponse(taskCwd);
				}
				if (summary?.state === "running" || !fromCheckpoint) {
					return await getWorkdirChangesFromRef({
						cwd: taskCwd,
						fromRef: toCheckpoint.commit,
					});
				}
				return await getWorkdirChangesBetweenRefs({
					cwd: taskCwd,
					fromRef: fromCheckpoint.commit,
					toRef: toCheckpoint.commit,
				});
			}
			return await getWorkdirChanges(taskCwd);
		},

		loadFileDiff: async (projectScope, input) => {
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

				let cwd = projectScope.projectPath;
				if (input.taskId) {
					const resolved = await tryResolveTaskCwd(projectScope.projectPath, input.taskId, input.baseRef ?? "");
					if (!resolved) return emptyResult;
					cwd = resolved;
				}

				return await getWorkdirFileDiff({
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
				return await getWorkdirFileDiff({
					cwd: projectScope.projectPath,
					path: input.path,
					previousPath: input.previousPath,
					status: input.status,
				});
			}

			const normalizedInput = normalizeRequiredTaskScopeInput(input);
			const taskCwd = await tryResolveTaskCwd(
				projectScope.projectPath,
				normalizedInput.taskId,
				normalizedInput.baseRef,
			);
			if (!taskCwd) return emptyResult;

			if (normalizedInput.mode === "last_turn") {
				const terminalManager = await ctx.deps.terminals.ensureTerminalManagerForProject(
					projectScope.projectId,
					projectScope.projectPath,
				);
				const summary = terminalManager.store.getSummary(normalizedInput.taskId);
				const fromCheckpoint = summary?.previousTurnCheckpoint;
				const toCheckpoint = summary?.latestTurnCheckpoint;
				if (!toCheckpoint) return emptyResult;

				return await getWorkdirFileDiff({
					cwd: taskCwd,
					path: input.path,
					previousPath: input.previousPath,
					status: input.status,
					fromRef: summary?.state === "running" || !fromCheckpoint ? toCheckpoint.commit : fromCheckpoint.commit,
					toRef: summary?.state === "running" || !fromCheckpoint ? undefined : toCheckpoint.commit,
				});
			}

			return await getWorkdirFileDiff({
				cwd: taskCwd,
				path: input.path,
				previousPath: input.previousPath,
				status: input.status,
			});
		},

		getCommitMessageContext: async (projectScope, taskScope, paths) => {
			const cwd = await resolveWorkingDir(projectScope.projectPath, taskScope);
			const args = ["diff", "HEAD", "--"];
			if (paths && paths.length > 0) {
				args.push(...paths);
			}
			const [changes, diffText] = await Promise.all([
				paths && paths.length > 0
					? getWorkdirChangesForPaths(cwd, paths, { countUntrackedLines: false })
					: getWorkdirChanges(cwd),
				getGitStdout(args, cwd, GIT_INSPECTION_OPTIONS),
			]);
			const files = selectCommitMessageFiles(changes.files, paths);
			const untrackedContext = await loadUntrackedFileContents(cwd, files);
			return {
				taskTitle: null,
				taskContext: null,
				files,
				diffText,
				...untrackedContext,
			};
		},

		loadWorkdirChanges: async (projectScope) => {
			return await getWorkdirChanges(projectScope.projectPath);
		},

		loadGitLog: async (projectScope, input) => {
			const cwd = await resolveWorkingDir(
				projectScope.projectPath,
				normalizeOptionalTaskScopeInput(input.taskScope ?? null),
			);
			return await getGitLog({
				cwd,
				ref: input.ref ?? null,
				refs: input.refs ?? null,
				maxCount: input.maxCount,
				skip: input.skip,
			});
		},

		loadGitRefs: async (projectScope, input) => {
			const cwd = await resolveWorkingDir(projectScope.projectPath, normalizeOptionalTaskScopeInput(input ?? null));
			return await getGitRefs(cwd);
		},

		loadCommitDiff: async (projectScope, input) => {
			const cwd = await resolveWorkingDir(
				projectScope.projectPath,
				normalizeOptionalTaskScopeInput(input.taskScope ?? null),
			);
			return await getCommitDiff({ cwd, commitHash: input.commitHash });
		},

		searchFiles: async (projectScope, input) => {
			const query = input.query.trim();
			const files = await searchWorkdirFiles(projectScope.projectPath, query, input.limit);
			return { query, files } satisfies RuntimeWorkdirFileSearchResponse;
		},

		searchText: async (projectScope, input) => {
			return (await searchWorkdirText(projectScope.projectPath, input.query, {
				caseSensitive: input.caseSensitive,
				isRegex: input.isRegex,
				limit: input.limit,
			})) satisfies RuntimeWorkdirTextSearchResponse;
		},

		listFiles: async (projectScope, input) => {
			if (!input.taskId) {
				if (input.ref) {
					const files = await listFilesAtRef(projectScope.projectPath, input.ref);
					return { files } satisfies RuntimeListFilesResponse;
				}
				const files = await listAllWorkdirFiles(projectScope.projectPath);
				return { files } satisfies RuntimeListFilesResponse;
			}

			const taskId = input.taskId.trim();
			if (!taskId) throw new Error("Missing taskId query parameter.");
			const taskCwd = await tryResolveTaskCwd(projectScope.projectPath, taskId, input.baseRef?.trim() ?? "");
			if (!taskCwd) return { files: [] } satisfies RuntimeListFilesResponse;

			if (input.ref) {
				const files = await listFilesAtRef(taskCwd, input.ref);
				return { files } satisfies RuntimeListFilesResponse;
			}

			const files = await listAllWorkdirFiles(taskCwd);
			return { files } satisfies RuntimeListFilesResponse;
		},

		getFileContent: async (projectScope, input) => {
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
				cwd = projectScope.projectPath;
			} else {
				const taskId = input.taskId.trim();
				if (!taskId) throw new Error("Missing taskId query parameter.");
				cwd = await tryResolveTaskCwd(projectScope.projectPath, taskId, input.baseRef?.trim() ?? "");
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

			return await readWorkdirFile(cwd, filePath);
		},
	};
}
