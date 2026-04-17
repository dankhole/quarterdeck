import { useCallback, useEffect, useRef, useState } from "react";

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
	filterUnresolvedPaths,
	shouldResetOnStepChange,
} from "./conflict-resolution";

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
	resolveFile: (path: string, resolution: "ours" | "theirs") => Promise<{ ok: boolean; error?: string }>;
	continueResolution: () => Promise<RuntimeConflictContinueResponse>;
	abortResolution: () => Promise<RuntimeConflictAbortResponse>;
	isLoading: boolean;
}

export function useConflictResolution(options: {
	taskId: string | null;
	projectId: string | null;
}): UseConflictResolutionResult {
	// 1. Call both hooks unconditionally (React rules of hooks).
	const taskConflictState = useConflictState(options.taskId);
	const homeConflictState = useHomeConflictState();

	// 2. Select based on taskId.
	const conflictState = options.taskId ? taskConflictState : homeConflictState;
	const isActive = conflictState !== null;

	// 3. State tracking.
	const [conflictFiles, setConflictFiles] = useState<RuntimeConflictFile[]>([]);
	const [resolvedFiles, setResolvedFiles] = useState<Set<string>>(new Set());
	const resolvedFilesRef = useRef<Set<string>>(resolvedFiles);
	resolvedFilesRef.current = resolvedFiles;
	const [autoMergedFiles, setAutoMergedFiles] = useState<RuntimeAutoMergedFile[]>([]);
	const [reviewedAutoMergedFiles, setReviewedAutoMergedFiles] = useState<Set<string>>(new Set());
	const [selectedPath, setSelectedPath] = useState<string | null>(null);
	const [isLoading, setIsLoading] = useState(false);
	const previousStepRef = useRef<number | null>(null);

	// 4. Reset resolvedFiles and reviewedAutoMergedFiles when currentStep changes (rebase advancing to next commit).
	useEffect(() => {
		const currentStep = conflictState?.currentStep ?? null;
		if (shouldResetOnStepChange(previousStepRef.current, currentStep)) {
			setResolvedFiles(new Set());
			setReviewedAutoMergedFiles(new Set());
		}
		previousStepRef.current = currentStep;
	}, [conflictState?.currentStep]);

	// 5. Reset everything when conflict becomes inactive.
	useEffect(() => {
		if (!isActive) {
			setConflictFiles([]);
			setResolvedFiles(new Set());
			setAutoMergedFiles([]);
			setReviewedAutoMergedFiles(new Set());
			setSelectedPath(null);
		}
	}, [isActive]);

	// 6. Load conflict file content when conflict state changes.
	useEffect(() => {
		if (!isActive || !conflictState || !options.projectId) return;

		const unresolvedPaths = filterUnresolvedPaths(conflictState.conflictedFiles, resolvedFilesRef.current);
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
				if (!cancelled && response.ok) {
					setConflictFiles(response.files);
				}
			})
			.catch(() => {
				// Error handled silently — files will remain empty.
			})
			.finally(() => {
				if (!cancelled) {
					setIsLoading(false);
				}
			});

		return () => {
			cancelled = true;
		};
		// eslint-disable-next-line react-hooks/exhaustive-deps -- intentionally keyed on conflictedFiles identity
	}, [conflictState?.conflictedFiles, isActive, options.taskId, options.projectId]);

	// 7. Detect external resolutions (metadata poll shows fewer conflicted files).
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
	}, [conflictState?.conflictedFiles, conflictState]);

	// 8. Fetch auto-merged file content when autoMergedFiles changes.
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
				if (!cancelled && response.ok) {
					setAutoMergedFiles(response.files);
				}
			})
			.catch(() => {
				// If we can't fetch content, treat all auto-merged files as implicitly accepted
				// rather than deadlocking the "Complete Merge" button.
				if (!cancelled) {
					setReviewedAutoMergedFiles(new Set(paths));
				}
			});

		return () => {
			cancelled = true;
		};
		// eslint-disable-next-line react-hooks/exhaustive-deps -- keyed on autoMergedFiles identity
	}, [conflictState?.autoMergedFiles, isActive, options.taskId, options.projectId]);

	// 9. Accept auto-merged file callback.
	const acceptAutoMergedFile = useCallback((path: string) => {
		setReviewedAutoMergedFiles((existing) => new Set([...existing, path]));
	}, []);

	// 10. Mutation wrappers.
	const resolveFile = useCallback(
		async (path: string, resolution: "ours" | "theirs"): Promise<{ ok: boolean; error?: string }> => {
			if (!options.projectId) {
				return { ok: false, error: "No project available" };
			}
			const trpcClient = getRuntimeTrpcClient(options.projectId);
			const result = await trpcClient.project.resolveConflictFile.mutate({
				taskId: options.taskId ?? undefined,
				path,
				resolution,
			});
			if (result.ok) {
				setResolvedFiles((existing) => new Set([...existing, path]));
			}
			return result;
		},
		[options.taskId, options.projectId],
	);

	const continueResolution = useCallback(async (): Promise<RuntimeConflictContinueResponse> => {
		if (!options.projectId) {
			return buildNoWorktreeContinueResponse();
		}
		const trpcClient = getRuntimeTrpcClient(options.projectId);
		return await trpcClient.project.continueConflictResolution.mutate({
			taskId: options.taskId ?? undefined,
		});
	}, [options.taskId, options.projectId]);

	const abortResolution = useCallback(async (): Promise<RuntimeConflictAbortResponse> => {
		if (!options.projectId) {
			return buildNoWorktreeAbortResponse();
		}
		const trpcClient = getRuntimeTrpcClient(options.projectId);
		return await trpcClient.project.abortConflictResolution.mutate({
			taskId: options.taskId ?? undefined,
		});
	}, [options.taskId, options.projectId]);

	return {
		isActive,
		conflictState,
		conflictFiles,
		resolvedFiles,
		autoMergedFiles,
		reviewedAutoMergedFiles,
		acceptAutoMergedFile,
		selectedPath,
		setSelectedPath,
		resolveFile,
		continueResolution,
		abortResolution,
		isLoading,
	};
}
