import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { getRuntimeTrpcClient } from "@/runtime/trpc-client";
import type {
	RuntimeAutoMergedFile,
	RuntimeConflictAbortResponse,
	RuntimeConflictContinueResponse,
	RuntimeConflictFile,
	RuntimeConflictState,
} from "@/runtime/types";
import { useConflictState, useHomeConflictState } from "@/stores/project-metadata-store";
import {
	buildNoWorktreeAbortResponse,
	buildNoWorktreeContinueResponse,
	detectExternallyResolvedFiles,
} from "./conflict-resolution";
import { createFileBrowserContentScopeKey, type FileBrowserScopeOptions } from "./file-browser-scope";
import { getFileEditorScopeGeneration, guardFileEditorScopes, subscribeFileEditorCache } from "./file-editor-cache";

export interface UseConflictResolutionResult {
	isActive: boolean;
	conflictState: RuntimeConflictState | null;
	conflictFiles: RuntimeConflictFile[];
	resolvedFiles: ReadonlySet<string>;
	autoMergedFiles: RuntimeAutoMergedFile[];
	reviewedAutoMergedFiles: ReadonlySet<string>;
	acceptAutoMergedFile: (path: string) => void;
	selectedPath: string | null;
	setSelectedPath: (path: string | null) => void;
	resolveFile: (
		path: string,
		resolution: "ours" | "theirs" | "manual",
		expectedContentHash?: string,
	) => Promise<{ ok: boolean; error?: string }>;
	continueResolution: () => Promise<RuntimeConflictContinueResponse>;
	abortResolution: () => Promise<RuntimeConflictAbortResponse>;
	isLoading: boolean;
	isMutating: boolean;
	actionError: string | null;
}

export function useConflictResolution(options: FileBrowserScopeOptions): UseConflictResolutionResult {
	// Call both hooks unconditionally (React rules of hooks).
	const taskConflictState = useConflictState(options.taskId);
	const homeConflictState = useHomeConflictState();

	// Select based on taskId.
	const conflictState = options.taskId ? taskConflictState : homeConflictState;
	const isActive = conflictState !== null;

	// State tracking.
	const [conflictFiles, setConflictFiles] = useState<RuntimeConflictFile[]>([]);
	const [resolvedFiles, setResolvedFiles] = useState<Set<string>>(new Set());
	const [autoMergedFiles, setAutoMergedFiles] = useState<RuntimeAutoMergedFile[]>([]);
	const [reviewedAutoMergedFiles, setReviewedAutoMergedFiles] = useState<Set<string>>(new Set());
	const [selectedPath, setSelectedPath] = useState<string | null>(null);
	const [isLoading, setIsLoading] = useState(false);
	const [isMutating, setIsMutating] = useState(false);
	const [actionError, setActionError] = useState<string | null>(null);

	const editorScopeKey = createFileBrowserContentScopeKey(options);
	const getScopeGeneration = useCallback(() => getFileEditorScopeGeneration(editorScopeKey), [editorScopeKey]);
	const scopeGeneration = useSyncExternalStore(subscribeFileEditorCache, getScopeGeneration);
	const scopeKey = JSON.stringify([
		editorScopeKey,
		conflictState?.operation,
		conflictState?.sourceBranch,
		conflictState?.currentStep,
	]);
	const scope = useMemo(() => ({ key: scopeKey, generation: scopeGeneration }), [scopeKey, scopeGeneration]);
	const [stateScope, setStateScope] = useState(scope);
	const currentScopeRef = useRef<typeof scope | null>(scope);
	currentScopeRef.current = scope;
	const mutationRef = useRef(false);
	useEffect(() => {
		currentScopeRef.current = scope;
		return () => {
			currentScopeRef.current = null;
		};
	}, [scope]);
	useEffect(() => {
		setStateScope(scope);
		setActionError(null);
		setIsLoading(false);
		setIsMutating(false);
		setConflictFiles([]);
		setAutoMergedFiles([]);
		setResolvedFiles(new Set());
		setReviewedAutoMergedFiles(new Set());
		previousConflictedFilesRef.current = [];
	}, [scope]);
	useEffect(() => {
		setSelectedPath(null);
	}, [scopeKey]);
	const isCurrentScope = useCallback(
		() => currentScopeRef.current === scope && scope.generation === getScopeGeneration(),
		[scope, getScopeGeneration],
	);
	const guardMutation = useCallback(() => {
		if (!isCurrentScope() || mutationRef.current || !options.projectId) return false;
		if (!guardFileEditorScopes({ projectId: options.projectId, taskId: options.taskId })) {
			setActionError("Save or discard unsaved files before changing conflict resolution.");
			return false;
		}
		return true;
	}, [isCurrentScope, options.projectId, options.taskId]);

	// Load conflict file content when conflict state changes.
	useEffect(() => {
		if (!isActive || !conflictState || !options.projectId) return;

		const unresolvedPaths = conflictState.conflictedFiles;
		if (unresolvedPaths.length === 0) return;

		let cancelled = false;
		setIsLoading(true);
		const trpcClient = getRuntimeTrpcClient(options.projectId);
		trpcClient.project.getConflictFiles
			.mutate({
				taskId: options.taskId ?? undefined,
				paths: unresolvedPaths,
			})
			.then((response) => {
				if (!cancelled && isCurrentScope() && response.ok) {
					setConflictFiles(response.files);
				}
			})
			.catch(() => {
				// Error handled silently — files will remain empty.
			})
			.finally(() => {
				if (!cancelled && isCurrentScope()) {
					setIsLoading(false);
				}
			});

		return () => {
			cancelled = true;
		};
	}, [conflictState?.conflictedFiles, isActive, options.taskId, options.projectId, isCurrentScope]);

	// Detect external resolutions (metadata poll shows fewer conflicted files).
	const previousConflictedFilesRef = useRef<string[]>([]);
	useEffect(() => {
		if (!conflictState) return;
		const disappeared = detectExternallyResolvedFiles(
			previousConflictedFilesRef.current,
			conflictState.conflictedFiles,
		);
		if (disappeared.length > 0) {
			setResolvedFiles((existing) => {
				const next = new Set(existing);
				for (const f of disappeared) next.add(f);
				return next;
			});
		}
		previousConflictedFilesRef.current = conflictState.conflictedFiles;
	}, [conflictState?.conflictedFiles, conflictState, scope]);

	// Fetch auto-merged file content when autoMergedFiles changes.
	useEffect(() => {
		if (!isActive || !conflictState || !options.projectId) return;
		const paths = conflictState.autoMergedFiles;
		if (paths.length === 0) {
			setAutoMergedFiles([]);
			return;
		}

		let cancelled = false;
		const trpcClient = getRuntimeTrpcClient(options.projectId);
		trpcClient.project.getAutoMergedFiles
			.mutate({
				taskId: options.taskId ?? undefined,
				paths,
			})
			.then((response) => {
				if (!cancelled && isCurrentScope() && response.ok) {
					setAutoMergedFiles(response.files);
				}
			})
			.catch(() => {
				// Reviewing auto-merged content is optional; a failed fetch must not
				// mark unseen files as reviewed or prevent completing the operation.
			});

		return () => {
			cancelled = true;
		};
	}, [conflictState?.autoMergedFiles, isActive, options.taskId, options.projectId, isCurrentScope]);

	// Accept auto-merged file callback.
	const acceptAutoMergedFile = useCallback((path: string) => {
		setReviewedAutoMergedFiles((existing) => new Set([...existing, path]));
	}, []);

	// Mutation wrappers.
	const resolveFile = useCallback(
		async (
			path: string,
			resolution: "ours" | "theirs" | "manual",
			expectedContentHash?: string,
		): Promise<{ ok: boolean; error?: string }> => {
			if (!options.projectId) {
				return { ok: false, error: "No project available" };
			}
			if (!guardMutation()) return { ok: false, error: "Review unsaved files before resolving." };
			mutationRef.current = true;
			setIsMutating(true);
			setActionError(null);
			try {
				const result = await getRuntimeTrpcClient(options.projectId).project.resolveConflictFile.mutate({
					taskId: options.taskId ?? undefined,
					path,
					resolution,
					expectedContentHash,
				});
				if (isCurrentScope()) {
					if (result.ok) setResolvedFiles((existing) => new Set([...existing, path]));
					else setActionError(result.error ?? "Could not resolve file.");
				}
				return result;
			} catch (error) {
				const message = error instanceof Error ? error.message : "Could not resolve file.";
				if (isCurrentScope()) setActionError(message);
				return { ok: false, error: message };
			} finally {
				mutationRef.current = false;
				if (isCurrentScope()) setIsMutating(false);
			}
		},
		[options.taskId, options.projectId, guardMutation, isCurrentScope],
	);

	const continueResolution = useCallback(async (): Promise<RuntimeConflictContinueResponse> => {
		if (!guardMutation()) return buildNoWorktreeContinueResponse();
		if (conflictState?.conflictedFiles.length) {
			setActionError("Resolve all conflicts before continuing.");
			return buildNoWorktreeContinueResponse();
		}
		mutationRef.current = true;
		setActionError(null);
		setIsMutating(true);
		try {
			if (!options.projectId) throw new Error("No project available");
			const response = await getRuntimeTrpcClient(options.projectId).project.continueConflictResolution.mutate({
				taskId: options.taskId ?? undefined,
			});
			if (isCurrentScope() && !response.ok) {
				setActionError(
					response.error ??
						(response.conflictState?.conflictedFiles.length
							? null
							: response.output || "Could not complete the operation."),
				);
			}
			return response;
		} catch (error) {
			const message = error instanceof Error ? error.message : "Could not complete the operation.";
			if (isCurrentScope()) setActionError(message);
			return { ...buildNoWorktreeContinueResponse(), error: message };
		} finally {
			mutationRef.current = false;
			if (isCurrentScope()) setIsMutating(false);
		}
	}, [options.taskId, options.projectId, guardMutation, isCurrentScope, conflictState]);

	const abortResolution = useCallback(async (): Promise<RuntimeConflictAbortResponse> => {
		if (!guardMutation()) return buildNoWorktreeAbortResponse();
		mutationRef.current = true;
		setActionError(null);
		setIsMutating(true);
		try {
			if (!options.projectId) throw new Error("No project available");
			const response = await getRuntimeTrpcClient(options.projectId).project.abortConflictResolution.mutate({
				taskId: options.taskId ?? undefined,
			});
			if (isCurrentScope() && !response.ok) setActionError(response.error ?? "Could not abort the operation.");
			return response;
		} catch (error) {
			const message = error instanceof Error ? error.message : "Could not abort the operation.";
			if (isCurrentScope()) setActionError(message);
			return { ...buildNoWorktreeAbortResponse(), error: message };
		} finally {
			mutationRef.current = false;
			if (isCurrentScope()) setIsMutating(false);
		}
	}, [options.taskId, options.projectId, guardMutation, isCurrentScope]);

	return {
		isActive,
		conflictState,
		conflictFiles: stateScope === scope ? conflictFiles : [],
		resolvedFiles: stateScope === scope ? resolvedFiles : new Set(),
		autoMergedFiles: stateScope === scope ? autoMergedFiles : [],
		reviewedAutoMergedFiles: stateScope === scope ? reviewedAutoMergedFiles : new Set(),
		acceptAutoMergedFile,
		selectedPath: stateScope.key === scopeKey ? selectedPath : null,
		setSelectedPath,
		resolveFile,
		continueResolution,
		abortResolution,
		isLoading,
		isMutating,
		actionError,
	};
}
