import { createWorkdirSearchScope, type WorkdirSearchScope } from "@/hooks/search/search-scope";
import type {
	RuntimeFileContentRequest,
	RuntimeFileSaveRequest,
	RuntimeListFilesRequest,
	RuntimeListFilesResponse,
	RuntimeWorkdirEntryCreateRequest,
	RuntimeWorkdirEntryDeleteRequest,
	RuntimeWorkdirEntryKind,
	RuntimeWorkdirEntryRenameRequest,
} from "@/runtime/types";

export interface FileBrowserScopeOptions {
	projectId: string | null;
	taskId: string | null;
	baseRef?: string;
	ref?: string | null;
	enabled?: boolean;
}

export interface FileBrowserScope {
	readonly projectId: string | null;
	readonly taskId: string | null;
	readonly baseRef?: string;
	readonly browseRef: string | null;
	readonly enabled: boolean;
	readonly contentScopeKey: string;
	readonly searchScope: WorkdirSearchScope;
	readonly canQueryRuntime: boolean;
	readonly isReadOnly: boolean;
}

export function createFileBrowserContentScopeKey(input: {
	projectId: string | null;
	taskId: string | null;
	baseRef?: string;
	ref?: string | null;
}): string {
	return JSON.stringify({
		projectId: input.projectId ?? "__no_project__",
		taskId: input.taskId ?? "__home__",
		baseRef: input.baseRef ?? "__default_base__",
		ref: input.ref ?? "__live__",
	});
}

export function resolveFileBrowserScope(options: FileBrowserScopeOptions): FileBrowserScope {
	const browseRef = options.ref ?? null;
	const enabled = options.enabled ?? true;
	return {
		projectId: options.projectId,
		taskId: options.taskId,
		...(options.baseRef ? { baseRef: options.baseRef } : {}),
		browseRef,
		enabled,
		contentScopeKey: createFileBrowserContentScopeKey({
			projectId: options.projectId,
			taskId: options.taskId,
			baseRef: options.baseRef,
			ref: browseRef,
		}),
		searchScope: createWorkdirSearchScope({
			taskId: options.taskId,
			baseRef: options.baseRef,
			ref: browseRef ?? undefined,
		}),
		canQueryRuntime: enabled && options.projectId !== null,
		isReadOnly: browseRef !== null,
	};
}

export function createListFilesRequest(scope: FileBrowserScope): RuntimeListFilesRequest {
	return {
		taskId: scope.taskId,
		...(scope.baseRef ? { baseRef: scope.baseRef } : {}),
		...(scope.browseRef ? { ref: scope.browseRef } : {}),
	};
}

export function createFileContentRequest(scope: FileBrowserScope, path: string): RuntimeFileContentRequest {
	return {
		taskId: scope.taskId,
		...(scope.baseRef ? { baseRef: scope.baseRef } : {}),
		path,
		...(scope.browseRef ? { ref: scope.browseRef } : {}),
	};
}

export function createFileSaveRequest(
	scope: FileBrowserScope,
	path: string,
	content: string,
	expectedContentHash: string,
): RuntimeFileSaveRequest {
	return {
		taskId: scope.taskId,
		...(scope.baseRef ? { baseRef: scope.baseRef } : {}),
		path,
		content,
		expectedContentHash,
	};
}

export function createWorkdirEntryCreateRequest(
	scope: FileBrowserScope,
	path: string,
	kind: RuntimeWorkdirEntryKind,
): RuntimeWorkdirEntryCreateRequest {
	return {
		taskId: scope.taskId,
		...(scope.baseRef ? { baseRef: scope.baseRef } : {}),
		path,
		kind,
	};
}

export function createWorkdirEntryRenameRequest(
	scope: FileBrowserScope,
	path: string,
	nextPath: string,
	kind: RuntimeWorkdirEntryKind,
): RuntimeWorkdirEntryRenameRequest {
	return {
		taskId: scope.taskId,
		...(scope.baseRef ? { baseRef: scope.baseRef } : {}),
		path,
		nextPath,
		kind,
	};
}

export function createWorkdirEntryDeleteRequest(
	scope: FileBrowserScope,
	path: string,
	kind: RuntimeWorkdirEntryKind,
): RuntimeWorkdirEntryDeleteRequest {
	return {
		taskId: scope.taskId,
		...(scope.baseRef ? { baseRef: scope.baseRef } : {}),
		path,
		kind,
	};
}

export function resolveFileBrowserMutationBlockedReason(input: {
	scope: FileBrowserScope;
	fileListData: RuntimeListFilesResponse | null;
}): string | null {
	if (input.scope.projectId === null) {
		return "No project selected.";
	}
	if (!input.scope.enabled) {
		return "Files view is not active.";
	}
	if (input.scope.isReadOnly) {
		return "Branch/ref browsing is read-only.";
	}
	if (input.fileListData === null) {
		return "Files are still loading.";
	}
	if (input.fileListData.mutable === false) {
		return input.fileListData.mutationBlockedReason ?? "File operations are unavailable.";
	}
	return null;
}
