import { type BaseRefWorktreeMetadata, loadBaseRefWorktreeMetadata } from "./project-metadata-base-ref";
import { type CachedPathWorktreeMetadata, loadPathWorktreeMetadata } from "./project-metadata-path-loader";
import {
	type ResolvedTaskWorktreeMetadataInput,
	type ResolvedTaskWorktreePath,
	resolveTaskWorktreeMetadataInput,
	type TrackedTaskWorktree,
} from "./project-metadata-paths";
import type { CachedTaskWorktreeMetadata } from "./project-metadata-task-cache";

export type { CachedTaskWorktreeMetadata } from "./project-metadata-task-cache";

export interface LoadedTaskWorktreeMetadata {
	taskId: string;
	metadata: CachedTaskWorktreeMetadata | null;
}

function derivePathMetadataFromTask(
	pathInfo: ResolvedTaskWorktreePath,
	current: CachedTaskWorktreeMetadata | null,
): CachedPathWorktreeMetadata | null {
	if (!current || current.data.path !== pathInfo.path || current.data.exists !== pathInfo.exists) {
		return null;
	}
	return {
		path: current.data.path,
		normalizedPath: pathInfo.normalizedPath,
		exists: current.data.exists,
		probeFailed: false,
		branch: current.data.branch,
		isDetached: current.data.isDetached,
		headCommit: current.data.headCommit,
		changedFiles: current.data.changedFiles,
		additions: current.data.additions,
		deletions: current.data.deletions,
		conflictState: current.data.conflictState ?? null,
		stateToken: current.stateToken,
		stateVersion: current.data.stateVersion,
		lastKnownBranch: current.lastKnownBranch,
	};
}

function canReuseTaskMetadata(
	task: TrackedTaskWorktree,
	pathInfo: ResolvedTaskWorktreePath,
	pathMetadata: CachedPathWorktreeMetadata,
	baseRefMetadata: BaseRefWorktreeMetadata,
	current: CachedTaskWorktreeMetadata | null,
): current is CachedTaskWorktreeMetadata {
	return (
		current !== null &&
		current.data.taskId === task.taskId &&
		current.data.path === pathInfo.path &&
		current.data.exists === pathMetadata.exists &&
		current.data.baseRef === pathInfo.baseRef &&
		current.stateToken === pathMetadata.stateToken &&
		current.baseRefCommit === baseRefMetadata.baseRefCommit &&
		current.originBaseRefCommit === baseRefMetadata.originBaseRefCommit
	);
}

export function projectTaskWorktreeMetadata(input: {
	task: TrackedTaskWorktree;
	pathInfo: ResolvedTaskWorktreePath;
	pathMetadata: CachedPathWorktreeMetadata;
	baseRefMetadata: BaseRefWorktreeMetadata;
	current: CachedTaskWorktreeMetadata | null;
}): CachedTaskWorktreeMetadata {
	const { task, pathInfo, pathMetadata, baseRefMetadata, current } = input;
	if (canReuseTaskMetadata(task, pathInfo, pathMetadata, baseRefMetadata, current)) {
		return current;
	}
	return {
		data: {
			taskId: task.taskId,
			path: pathInfo.path,
			exists: pathMetadata.exists,
			baseRef: pathInfo.baseRef,
			branch: pathMetadata.branch,
			isDetached: pathMetadata.isDetached,
			headCommit: pathMetadata.headCommit,
			changedFiles: pathMetadata.changedFiles,
			additions: pathMetadata.additions,
			deletions: pathMetadata.deletions,
			hasUnmergedChanges: baseRefMetadata.hasUnmergedChanges,
			behindBaseCount: baseRefMetadata.behindBaseCount,
			conflictState: pathMetadata.conflictState,
			stateVersion: Date.now(),
		},
		stateToken: pathMetadata.stateToken,
		baseRefCommit: baseRefMetadata.baseRefCommit,
		originBaseRefCommit: baseRefMetadata.originBaseRefCommit,
		lastKnownBranch: pathMetadata.lastKnownBranch,
	};
}

function selectCurrentPathMetadata(inputs: ResolvedTaskWorktreeMetadataInput[]): CachedPathWorktreeMetadata | null {
	for (const input of inputs) {
		const currentPathMetadata = derivePathMetadataFromTask(input.pathInfo, input.current);
		if (currentPathMetadata) {
			return currentPathMetadata;
		}
	}
	return null;
}

function selectCurrentBaseRefMetadataInput(
	inputs: ResolvedTaskWorktreeMetadataInput[],
	pathMetadata: CachedPathWorktreeMetadata,
	baseRef: string,
): CachedTaskWorktreeMetadata | null {
	for (const input of inputs) {
		if (
			input.pathInfo.baseRef === baseRef &&
			input.current &&
			input.current.data.path === input.pathInfo.path &&
			input.current.data.baseRef === baseRef &&
			input.current.stateToken === pathMetadata.stateToken
		) {
			return input.current;
		}
	}
	return null;
}

async function loadTaskWorktreeMetadataForResolvedPath(
	inputs: ResolvedTaskWorktreeMetadataInput[],
): Promise<LoadedTaskWorktreeMetadata[]> {
	if (inputs.length === 0) {
		return [];
	}
	const pathInfo = inputs[0]?.pathInfo;
	if (!pathInfo) {
		return [];
	}
	const pathMetadata = await loadPathWorktreeMetadata(pathInfo, selectCurrentPathMetadata(inputs));
	if (pathMetadata.probeFailed) {
		return inputs.map((input) => ({
			taskId: input.task.taskId,
			metadata:
				input.current ??
				projectTaskWorktreeMetadata({
					task: input.task,
					pathInfo: input.pathInfo,
					pathMetadata: {
						...pathMetadata,
						path: input.pathInfo.path,
						normalizedPath: input.pathInfo.normalizedPath,
						branch: null,
						isDetached: false,
						headCommit: null,
						changedFiles: null,
						additions: null,
						deletions: null,
						conflictState: null,
						stateToken: null,
						lastKnownBranch: null,
					},
					baseRefMetadata: {
						baseRefCommit: null,
						originBaseRefCommit: null,
						hasUnmergedChanges: null,
						behindBaseCount: null,
					},
					current: input.current,
				}),
		}));
	}
	const baseRefMetadataByRef = new Map<string, BaseRefWorktreeMetadata>();
	const results: LoadedTaskWorktreeMetadata[] = [];

	for (const input of inputs) {
		let baseRefMetadata = baseRefMetadataByRef.get(input.pathInfo.baseRef);
		if (!baseRefMetadata) {
			baseRefMetadata = await loadBaseRefWorktreeMetadata(
				input.pathInfo,
				pathMetadata,
				selectCurrentBaseRefMetadataInput(inputs, pathMetadata, input.pathInfo.baseRef),
			);
			baseRefMetadataByRef.set(input.pathInfo.baseRef, baseRefMetadata);
		}
		results.push({
			taskId: input.task.taskId,
			metadata: projectTaskWorktreeMetadata({
				task: input.task,
				pathInfo: input.pathInfo,
				pathMetadata,
				baseRefMetadata,
				current: input.current,
			}),
		});
	}
	return results;
}

export async function loadTaskWorktreeMetadataBatch(
	inputs: ResolvedTaskWorktreeMetadataInput[],
): Promise<LoadedTaskWorktreeMetadata[]> {
	const groups = new Map<string, ResolvedTaskWorktreeMetadataInput[]>();
	for (const input of inputs) {
		const currentGroup = groups.get(input.pathInfo.normalizedPath);
		if (currentGroup) {
			currentGroup.push(input);
		} else {
			groups.set(input.pathInfo.normalizedPath, [input]);
		}
	}
	const loaded: LoadedTaskWorktreeMetadata[] = [];
	for (const group of groups.values()) {
		loaded.push(...(await loadTaskWorktreeMetadataForResolvedPath(group)));
	}
	return loaded;
}

export async function loadTaskWorktreeMetadata(
	projectPath: string,
	task: TrackedTaskWorktree,
	current: CachedTaskWorktreeMetadata | null,
): Promise<CachedTaskWorktreeMetadata | null> {
	const input = await resolveTaskWorktreeMetadataInput(projectPath, task, current);
	const [loaded] = await loadTaskWorktreeMetadataBatch([input]);
	return loaded?.metadata ?? null;
}
