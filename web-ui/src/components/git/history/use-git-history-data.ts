import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import type { GitCommitDiffSource } from "@/components/git/history/git-commit-diff-panel";
import { getRuntimeTrpcClient } from "@/runtime/trpc-client";
import type {
	RuntimeGitCommit,
	RuntimeGitCommitDiffResponse,
	RuntimeGitRef,
	RuntimeGitRefsResponse,
	RuntimeGitSyncSummary,
	RuntimeWorkdirChangesResponse,
} from "@/runtime/types";
import { useTrpcQuery } from "@/runtime/use-trpc-query";
import { toErrorMessage } from "@/utils/to-error-message";

export type GitHistoryViewMode = "working-copy" | "commit";

const INITIAL_COMMIT_PAGE_SIZE = 150;
const COMMIT_PAGE_SIZE = 150;
const EMPTY_REFS: RuntimeGitRef[] = [];
const EMPTY_LOG_REFS: string[] = [];

interface GitHistoryTaskScope {
	taskId: string;
	baseRef: string;
}

interface UseGitHistoryDataOptions {
	projectId: string | null;
	taskScope?: GitHistoryTaskScope | null;
	gitSummary: RuntimeGitSyncSummary | null;
	stateVersion?: number;
	enabled?: boolean;
}

interface GitHistoryRefreshOptions {
	background?: boolean;
}

export interface UseGitHistoryDataResult {
	viewMode: GitHistoryViewMode;
	refs: RuntimeGitRef[];
	activeRef: RuntimeGitRef | null;
	refsErrorMessage: string | null;
	isRefsLoading: boolean;
	workingCopyFileCount: number;
	hasWorkingCopy: boolean;
	commits: RuntimeGitCommit[];
	totalCommitCount: number;
	selectedCommitHash: string | null;
	selectedCommit: RuntimeGitCommit | null;
	isLogLoading: boolean;
	isLoadingMoreCommits: boolean;
	logErrorMessage: string | null;
	diffSource: GitCommitDiffSource | null;
	isDiffLoading: boolean;
	diffErrorMessage: string | null;
	selectedDiffPath: string | null;
	selectWorkingCopy: () => void;
	selectRef: (ref: RuntimeGitRef) => void;
	selectCommit: (commit: RuntimeGitCommit) => void;
	selectDiffPath: (path: string | null) => void;
	loadMoreCommits: () => void;
	refresh: (options?: GitHistoryRefreshOptions) => void;
}

export function useGitHistoryData({
	projectId,
	taskScope,
	gitSummary,
	stateVersion = 0,
	enabled = true,
}: UseGitHistoryDataOptions): UseGitHistoryDataResult {
	const [viewMode, setViewMode] = useState<GitHistoryViewMode>("commit");
	const [selectedRefName, setSelectedRefName] = useState<string | null>(null);
	const [selectedCommitHash, setSelectedCommitHash] = useState<string | null>(null);
	const [selectedDiffPath, setSelectedDiffPath] = useState<string | null>(null);
	const [commits, setCommits] = useState<RuntimeGitCommit[]>([]);
	const [totalCommitCount, setTotalCommitCount] = useState(0);
	const [isLogLoading, setIsLogLoading] = useState(false);
	const [isLoadingMoreCommits, setIsLoadingMoreCommits] = useState(false);
	const [logErrorMessage, setLogErrorMessage] = useState<string | null>(null);
	const [resolvedLogKey, setResolvedLogKey] = useState<string | null>(null);
	// Commit log requests can overlap when users switch refs quickly or trigger refresh/load-more.
	// We cancel older in-flight requests so stale responses cannot overwrite state from newer requests.
	const logAbortControllerRef = useRef<AbortController | null>(null);

	const abortInFlightLogRequest = useCallback(() => {
		logAbortControllerRef.current?.abort();
		logAbortControllerRef.current = null;
	}, []);

	const isAbortError = useCallback((error: unknown): boolean => {
		if (!(error instanceof Error)) {
			return false;
		}
		const name = error.name.toLowerCase();
		const message = error.message.toLowerCase();
		return name === "aborterror" || message.includes("aborted") || message.includes("aborterror");
	}, []);

	const refsQueryFn = useCallback(async () => {
		if (!projectId) {
			throw new Error("Missing project.");
		}
		const trpc = getRuntimeTrpcClient(projectId);
		const payload = await trpc.project.getGitRefs.query(taskScope ?? null);
		if (!payload.ok) {
			throw new Error(payload.error ?? "Could not load git refs.");
		}
		return payload;
	}, [taskScope, projectId]);

	const refsQuery = useTrpcQuery<RuntimeGitRefsResponse>({
		enabled: enabled && projectId !== null,
		queryFn: refsQueryFn,
		retainDataOnError: true,
	});

	const scopeKey = `${projectId ?? "__none__"}:${taskScope?.taskId ?? "__home__"}:${taskScope?.baseRef ?? "__home__"}`;
	const prevScopeKeyRef = useRef(scopeKey);
	const isScopeTransitioning = prevScopeKeyRef.current !== scopeKey;

	const prevBranchRef = useRef(gitSummary?.currentBranch ?? null);
	useEffect(() => {
		const current = gitSummary?.currentBranch ?? null;
		if (current !== prevBranchRef.current) {
			prevBranchRef.current = current;
			setSelectedRefName(null);
			setSelectedCommitHash(null);
			if (enabled) {
				void refsQuery.refetch();
			}
		}
	}, [enabled, gitSummary?.currentBranch, refsQuery.refetch]);

	const refs = isScopeTransitioning ? EMPTY_REFS : (refsQuery.data?.refs ?? EMPTY_REFS);
	const isRefsLoadingVisible =
		isScopeTransitioning ||
		(enabled && projectId !== null && refsQuery.data === null && !refsQuery.isError) ||
		(refsQuery.isLoading && refs.length === 0);
	const refsErrorMessage =
		!isScopeTransitioning && refsQuery.isError && refs.length === 0
			? (refsQuery.error?.message ?? "Could not load git refs.")
			: null;
	const headRef = refs.find((ref) => ref.isHead);

	const activeRef = useMemo(() => {
		if (selectedRefName) {
			return refs.find((ref) => ref.name === selectedRefName) ?? headRef ?? null;
		}
		return headRef ?? null;
	}, [headRef, refs, selectedRefName]);

	const logRefs = useMemo(() => {
		if (!activeRef) {
			return EMPTY_LOG_REFS;
		}
		if (activeRef.type === "detached") {
			return [activeRef.hash];
		}
		if (activeRef.type === "branch") {
			const resolvedRefs = [activeRef.name];
			if (activeRef.upstreamName && refs.some((ref) => ref.name === activeRef.upstreamName)) {
				resolvedRefs.push(activeRef.upstreamName);
			}
			return resolvedRefs;
		}
		return [activeRef.name];
	}, [activeRef, refs]);
	const logKey = `${scopeKey}:${logRefs.length > 0 ? logRefs.join("|") : "__no_ref__"}`;

	const loadCommits = useCallback(
		async (options: { skip: number; maxCount: number; append: boolean; silent?: boolean }) => {
			if (!enabled || !projectId || logRefs.length === 0) {
				abortInFlightLogRequest();
				setCommits([]);
				setTotalCommitCount(0);
				setLogErrorMessage(null);
				setIsLogLoading(false);
				setIsLoadingMoreCommits(false);
				return;
			}

			abortInFlightLogRequest();
			const abortController = new AbortController();
			logAbortControllerRef.current = abortController;
			if (options.append) {
				setIsLoadingMoreCommits(true);
			} else {
				if (!options.silent) {
					setIsLogLoading(true);
					setLogErrorMessage(null);
				} else {
					setIsLogLoading(false);
				}
			}

			try {
				const trpc = getRuntimeTrpcClient(projectId);
				const payload = await trpc.project.getGitLog.query(
					{
						ref: logRefs[0] ?? null,
						refs: logRefs,
						maxCount: options.maxCount,
						skip: options.skip,
						taskScope: taskScope ?? null,
					},
					{
						signal: abortController.signal,
					},
				);
				if (abortController.signal.aborted || logAbortControllerRef.current !== abortController) {
					return;
				}
				if (!payload.ok) {
					if (options.silent) {
						setResolvedLogKey(logKey);
						return;
					}
					if (!options.append) {
						setCommits([]);
						setTotalCommitCount(0);
					}
					setLogErrorMessage(payload.error ?? "Could not load commits.");
					setResolvedLogKey(logKey);
					return;
				}

				setLogErrorMessage(null);
				setTotalCommitCount(payload.totalCount);
				setResolvedLogKey(logKey);
				setCommits((current) => {
					if (!options.append) {
						return payload.commits;
					}
					const existingHashes = new Set(current.map((commit) => commit.hash));
					const nextCommits = payload.commits.filter((commit) => !existingHashes.has(commit.hash));
					return [...current, ...nextCommits];
				});
			} catch (error) {
				if (abortController.signal.aborted || logAbortControllerRef.current !== abortController) {
					return;
				}
				if (isAbortError(error)) {
					return;
				}
				if (options.silent) {
					return;
				}
				const message = toErrorMessage(error);
				if (!options.append) {
					setCommits([]);
					setTotalCommitCount(0);
				}
				setLogErrorMessage(message || "Could not load commits.");
				setResolvedLogKey(logKey);
			} finally {
				if (logAbortControllerRef.current === abortController) {
					logAbortControllerRef.current = null;
					if (options.append) {
						setIsLoadingMoreCommits(false);
					} else {
						setIsLogLoading(false);
					}
				}
			}
		},
		[abortInFlightLogRequest, enabled, isAbortError, logKey, logRefs, taskScope, projectId],
	);

	useEffect(() => {
		abortInFlightLogRequest();
		setCommits([]);
		setTotalCommitCount(0);
		setIsLogLoading(false);
		setIsLoadingMoreCommits(false);
		setLogErrorMessage(null);
		setResolvedLogKey(null);
		if (!enabled || !projectId || logRefs.length === 0) {
			return;
		}
		void loadCommits({
			skip: 0,
			maxCount: INITIAL_COMMIT_PAGE_SIZE,
			append: false,
		});
	}, [abortInFlightLogRequest, enabled, loadCommits, logRefs, projectId]);

	useEffect(() => {
		return () => {
			abortInFlightLogRequest();
		};
	}, [abortInFlightLogRequest]);

	const loadMoreCommits = useCallback(() => {
		if (!enabled || !projectId || logRefs.length === 0 || isLogLoading || isLoadingMoreCommits) {
			return;
		}
		if (commits.length >= totalCommitCount) {
			return;
		}
		void loadCommits({
			skip: commits.length,
			maxCount: COMMIT_PAGE_SIZE,
			append: true,
		});
	}, [commits.length, enabled, isLoadingMoreCommits, isLogLoading, loadCommits, logRefs, totalCommitCount, projectId]);

	const refreshCommits = useCallback(
		(options?: { silent?: boolean }) => {
			if (!enabled || !projectId || logRefs.length === 0) {
				return;
			}
			void loadCommits({
				skip: 0,
				maxCount: Math.max(commits.length, INITIAL_COMMIT_PAGE_SIZE),
				append: false,
				silent: options?.silent ?? false,
			});
		},
		[commits.length, enabled, loadCommits, logRefs, projectId],
	);

	const resolvedLogErrorMessage = refsErrorMessage ?? logErrorMessage;

	useEffect(() => {
		if (viewMode === "working-copy") {
			return;
		}
		if (selectedCommitHash && commits.some((commit) => commit.hash === selectedCommitHash)) {
			return;
		}
		const preferredCommit = activeRef
			? (commits.find((commit) => commit.hash === activeRef.hash) ?? commits[0])
			: commits[0];
		setSelectedCommitHash(preferredCommit?.hash ?? null);
		setSelectedDiffPath(null);
	}, [activeRef, commits, selectedCommitHash, viewMode]);

	const diffQueryFn = useCallback(async () => {
		if (!projectId || !selectedCommitHash) {
			throw new Error("Missing scope.");
		}
		const trpc = getRuntimeTrpcClient(projectId);
		return await trpc.project.getCommitDiff.query({
			commitHash: selectedCommitHash,
			taskScope: taskScope ?? null,
		});
	}, [selectedCommitHash, taskScope, projectId]);

	const diffQuery = useTrpcQuery<RuntimeGitCommitDiffResponse>({
		enabled:
			!isScopeTransitioning && enabled && projectId !== null && selectedCommitHash !== null && viewMode === "commit",
		queryFn: diffQueryFn,
	});

	const summaryWorkingCopyFileCount = gitSummary?.changedFiles ?? null;

	const workingCopyQueryFn = useCallback(async () => {
		if (!projectId) {
			throw new Error("Missing project.");
		}
		const trpc = getRuntimeTrpcClient(projectId);
		if (taskScope) {
			return await trpc.project.getChanges.query(taskScope);
		}
		return await trpc.project.getWorkspaceChanges.query();
	}, [taskScope, projectId]);
	const shouldLoadWorkingCopyChanges =
		!isScopeTransitioning &&
		enabled &&
		projectId !== null &&
		(taskScope != null || (summaryWorkingCopyFileCount ?? 0) > 0);

	const workingCopyQuery = useTrpcQuery<RuntimeWorkdirChangesResponse>({
		enabled: shouldLoadWorkingCopyChanges,
		queryFn: workingCopyQueryFn,
		retainDataOnError: true,
	});

	useEffect(() => {
		if (enabled) {
			return;
		}
		abortInFlightLogRequest();
		setCommits([]);
		setTotalCommitCount(0);
		setIsLogLoading(false);
		setIsLoadingMoreCommits(false);
		setLogErrorMessage(null);
		setResolvedLogKey(null);
		refsQuery.setData(null);
		diffQuery.setData(null);
		workingCopyQuery.setData(null);
	}, [abortInFlightLogRequest, diffQuery.setData, enabled, refsQuery.setData, workingCopyQuery.setData]);

	useEffect(() => {
		if (!isScopeTransitioning) {
			return;
		}
		prevScopeKeyRef.current = scopeKey;
		abortInFlightLogRequest();
		setViewMode("commit");
		setSelectedRefName(null);
		setSelectedCommitHash(null);
		setSelectedDiffPath(null);
		setCommits([]);
		setTotalCommitCount(0);
		setIsLogLoading(false);
		setIsLoadingMoreCommits(false);
		setLogErrorMessage(null);
		setResolvedLogKey(null);
		refsQuery.setData(null);
		diffQuery.setData(null);
		workingCopyQuery.setData(null);
	}, [
		abortInFlightLogRequest,
		diffQuery.setData,
		isScopeTransitioning,
		refsQuery.setData,
		scopeKey,
		workingCopyQuery.setData,
	]);

	const workingCopyFileCount = summaryWorkingCopyFileCount ?? workingCopyQuery.data?.files.length ?? 0;
	const hasWorkingCopy = workingCopyFileCount > 0;
	const isLogLoadingVisible =
		isScopeTransitioning ||
		isRefsLoadingVisible ||
		isLogLoading ||
		(enabled && projectId !== null && logRefs.length > 0 && resolvedLogKey !== logKey);
	const previousStateVersionRef = useRef(stateVersion);

	useEffect(() => {
		if (previousStateVersionRef.current === stateVersion) {
			return;
		}
		previousStateVersionRef.current = stateVersion;
		if (!enabled || !projectId || isScopeTransitioning) {
			return;
		}
		void refsQuery.refetch();
		refreshCommits({ silent: true });
		if (shouldLoadWorkingCopyChanges || workingCopyQuery.data) {
			void workingCopyQuery.refetch();
		}
	}, [
		enabled,
		refsQuery.refetch,
		refreshCommits,
		shouldLoadWorkingCopyChanges,
		stateVersion,
		isScopeTransitioning,
		workingCopyQuery.data,
		workingCopyQuery.refetch,
		projectId,
	]);

	const selectWorkingCopy = useCallback(() => {
		setViewMode("working-copy");
		setSelectedRefName(null);
		setSelectedCommitHash(null);
		setSelectedDiffPath(null);
	}, []);

	const selectRef = useCallback((ref: RuntimeGitRef) => {
		setSelectedRefName(ref.name);
		setViewMode("commit");
		setSelectedCommitHash(null);
		setSelectedDiffPath(null);
	}, []);

	const selectCommit = useCallback((commit: RuntimeGitCommit) => {
		setViewMode("commit");
		setSelectedCommitHash(commit.hash);
		setSelectedDiffPath(null);
	}, []);

	const diffSource = useMemo((): GitCommitDiffSource | null => {
		if (viewMode === "working-copy") {
			const files = workingCopyQuery.data?.files;
			if (!files) {
				return null;
			}
			return { type: "working-copy", files };
		}
		const commitFiles = diffQuery.data?.files;
		if (!commitFiles) {
			return null;
		}
		return { type: "commit", files: commitFiles };
	}, [diffQuery.data?.files, viewMode, workingCopyQuery.data?.files]);

	const selectedCommit = commits.find((commit) => commit.hash === selectedCommitHash) ?? null;
	const isDiffLoading =
		viewMode === "commit"
			? isLogLoading || diffQuery.isLoading
			: workingCopyQuery.isLoading && !workingCopyQuery.data;
	const diffErrorMessage =
		viewMode === "commit"
			? (resolvedLogErrorMessage ??
				(diffQuery.isError
					? (diffQuery.error?.message ?? "Could not load diff.")
					: diffQuery.data && !diffQuery.data.ok
						? (diffQuery.data.error ?? "Could not load diff.")
						: null))
			: workingCopyQuery.isError && !workingCopyQuery.data
				? (workingCopyQuery.error?.message ?? "Could not load working copy changes.")
				: null;

	useEffect(() => {
		if (!hasWorkingCopy && viewMode === "working-copy") {
			setViewMode("commit");
			setSelectedDiffPath(null);
		}
	}, [hasWorkingCopy, viewMode]);

	const refresh = useCallback(
		(options?: GitHistoryRefreshOptions) => {
			if (!enabled || isScopeTransitioning) {
				return;
			}
			const isBackgroundRefresh = options?.background === true;
			if (isBackgroundRefresh) {
				if (!refsQuery.isLoading) {
					void refsQuery.refetch();
				}
				if (!isLogLoading && !isLoadingMoreCommits) {
					refreshCommits({
						silent: true,
					});
				}
				if (shouldLoadWorkingCopyChanges && !workingCopyQuery.isLoading) {
					void workingCopyQuery.refetch();
				}
				return;
			}

			void refsQuery.refetch();
			refreshCommits({
				silent: false,
			});
			if (shouldLoadWorkingCopyChanges) {
				void workingCopyQuery.refetch();
			}
		},
		[
			enabled,
			isScopeTransitioning,
			isLoadingMoreCommits,
			isLogLoading,
			refsQuery,
			refsQueryFn,
			refreshCommits,
			shouldLoadWorkingCopyChanges,
			workingCopyQuery,
			workingCopyQueryFn,
		],
	);

	const visibleCommits = isScopeTransitioning ? [] : commits;
	const visibleSelectedCommitHash = isScopeTransitioning ? null : selectedCommitHash;
	const visibleSelectedCommit = isScopeTransitioning ? null : selectedCommit;
	const visibleWorkingCopyFileCount = isScopeTransitioning ? 0 : workingCopyFileCount;
	const visibleHasWorkingCopy = isScopeTransitioning ? false : hasWorkingCopy;
	const visibleDiffSource = isScopeTransitioning ? null : diffSource;
	const visibleSelectedDiffPath = isScopeTransitioning ? null : selectedDiffPath;
	const visibleRefsErrorMessage = isScopeTransitioning ? null : refsErrorMessage;
	const visibleLogErrorMessage = isScopeTransitioning ? null : resolvedLogErrorMessage;
	const visibleDiffErrorMessage = isScopeTransitioning ? null : diffErrorMessage;

	return {
		viewMode,
		refs,
		activeRef,
		refsErrorMessage: visibleRefsErrorMessage,
		isRefsLoading: isRefsLoadingVisible,
		workingCopyFileCount: visibleWorkingCopyFileCount,
		hasWorkingCopy: visibleHasWorkingCopy,
		commits: visibleCommits,
		totalCommitCount: isScopeTransitioning ? 0 : totalCommitCount,
		selectedCommitHash: visibleSelectedCommitHash,
		selectedCommit: visibleSelectedCommit,
		isLogLoading: isLogLoadingVisible,
		isLoadingMoreCommits,
		logErrorMessage: visibleLogErrorMessage,
		diffSource: visibleDiffSource,
		isDiffLoading: isScopeTransitioning || isRefsLoadingVisible || isLogLoadingVisible || isDiffLoading,
		diffErrorMessage: visibleDiffErrorMessage,
		selectedDiffPath: visibleSelectedDiffPath,
		selectWorkingCopy,
		selectRef,
		selectCommit,
		selectDiffPath: setSelectedDiffPath,
		loadMoreCommits,
		refresh,
	};
}
