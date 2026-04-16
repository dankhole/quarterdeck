import { useCallback, useEffect, useRef, useState } from "react";

import { getRuntimeTrpcClient } from "@/runtime/trpc-client";
import type {
	RuntimeAutoMergedFile,
	RuntimeConflictAbortResponse,
	RuntimeConflictContinueResponse,
	RuntimeConflictFile,
	RuntimeConflictState,
	RuntimeGitSyncSummary,
} from "@/runtime/types";
import { useConflictState, useHomeConflictState } from "@/stores/workspace-metadata-store";

const emptySummary: RuntimeGitSyncSummary = {
	currentBranch: null,
	upstreamBranch: null,
	changedFiles: 0,
	additions: 0,
	deletions: 0,
	aheadCount: 0,
	behindCount: 0,
};

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
	workspaceId: string | null;
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
		if (currentStep !== previousStepRef.current) {
			if (previousStepRef.current !== null && currentStep !== null) {
				setResolvedFiles(new Set());
				setReviewedAutoMergedFiles(new Set());
			}
			previousStepRef.current = currentStep;
		}
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
		if (!isActive || !conflictState || !options.workspaceId) return;

		const unresolvedPaths = conflictState.conflictedFiles.filter((f) => !resolvedFilesRef.current.has(f));
		if (unresolvedPaths.length === 0) return;

		let cancelled = false;
		setIsLoading(true);
		const trpcClient = getRuntimeTrpcClient(options.workspaceId);
		trpcClient.workspace.getConflictFiles
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
	}, [conflictState?.conflictedFiles, isActive, options.taskId, options.workspaceId]);

	// 7. Detect external resolutions (metadata poll shows fewer conflicted files).
	//    When conflictedFiles shrinks, add disappeared files to resolvedFiles.
	const previousConflictedFilesRef = useRef<string[]>([]);
	useEffect(() => {
		if (!conflictState) return;
		const prev = previousConflictedFilesRef.current;
		const curr = conflictState.conflictedFiles;
		if (prev.length > 0 && curr.length < prev.length) {
			const disappeared = prev.filter((f) => !curr.includes(f));
			if (disappeared.length > 0) {
				setResolvedFiles((existing) => {
					const next = new Set(existing);
					for (const f of disappeared) next.add(f);
					return next;
				});
			}
		}
		previousConflictedFilesRef.current = curr;
	}, [conflictState?.conflictedFiles, conflictState]);

	// 8. Fetch auto-merged file content when autoMergedFiles changes.
	useEffect(() => {
		if (!isActive || !conflictState || !options.workspaceId) return;
		const paths = conflictState.autoMergedFiles;
		if (paths.length === 0) {
			setAutoMergedFiles([]);
			return;
		}

		let cancelled = false;
		const trpcClient = getRuntimeTrpcClient(options.workspaceId);
		trpcClient.workspace.getAutoMergedFiles
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
	}, [conflictState?.autoMergedFiles, isActive, options.taskId, options.workspaceId]);

	// 9. Accept auto-merged file callback.
	const acceptAutoMergedFile = useCallback((path: string) => {
		setReviewedAutoMergedFiles((existing) => new Set([...existing, path]));
	}, []);

	// 10. Mutation wrappers.
	const resolveFile = useCallback(
		async (path: string, resolution: "ours" | "theirs"): Promise<{ ok: boolean; error?: string }> => {
			if (!options.workspaceId) {
				return { ok: false, error: "No workspace available" };
			}
			const trpcClient = getRuntimeTrpcClient(options.workspaceId);
			const result = await trpcClient.workspace.resolveConflictFile.mutate({
				taskId: options.taskId ?? undefined,
				path,
				resolution,
			});
			if (result.ok) {
				setResolvedFiles((existing) => new Set([...existing, path]));
			}
			return result;
		},
		[options.taskId, options.workspaceId],
	);

	const continueResolution = useCallback(async (): Promise<RuntimeConflictContinueResponse> => {
		if (!options.workspaceId) {
			return { ok: false, completed: false, summary: emptySummary, output: "" };
		}
		const trpcClient = getRuntimeTrpcClient(options.workspaceId);
		return await trpcClient.workspace.continueConflictResolution.mutate({
			taskId: options.taskId ?? undefined,
		});
	}, [options.taskId, options.workspaceId]);

	const abortResolution = useCallback(async (): Promise<RuntimeConflictAbortResponse> => {
		if (!options.workspaceId) {
			return { ok: false, summary: emptySummary };
		}
		const trpcClient = getRuntimeTrpcClient(options.workspaceId);
		return await trpcClient.workspace.abortConflictResolution.mutate({
			taskId: options.taskId ?? undefined,
		});
	}, [options.taskId, options.workspaceId]);

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
