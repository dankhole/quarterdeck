import { useCallback, useEffect, useMemo, useState } from "react";
import { areGitRefsResponsesEqual } from "@/runtime/query-equality";
import { getRuntimeTrpcClient } from "@/runtime/trpc-client";
import type { RuntimeGitRef, RuntimeGitRefsResponse, RuntimeGitSyncSummary } from "@/runtime/types";
import { useTrpcQuery } from "@/runtime/use-trpc-query";
import { LocalStorageKey } from "@/storage/local-storage-store";
import { useTaskRepositoryInfoValue, useTaskWorktreeSnapshotValue } from "@/stores/project-metadata-store";
import type { BoardData, CardSelection } from "@/types";
import { useBooleanLocalStorageValue } from "@/utils/react-use";
import { resolveDefaultCompareSourceRef } from "./git-view-compare";

export { resolveDefaultCompareSourceRef } from "./git-view-compare";

export interface GitViewCompareNavigation {
	sourceRef?: string;
	targetRef?: string;
}

export interface UseGitViewCompareOptions {
	selectedCard: CardSelection | null;
	currentProjectId: string | null;
	projectPath?: string | null;
	homeGitSummary: RuntimeGitSyncSummary | null;
	board: BoardData;
	isActive: boolean;
	pendingNavigation?: GitViewCompareNavigation | null;
	onNavigationConsumed?: () => void;
}

export interface UseGitViewCompareResult {
	sourceRef: string | null;
	targetRef: string | null;
	defaultSourceRef: string | null;
	defaultTargetRef: string | null;
	setSourceRef: (ref: string) => void;
	setTargetRef: (ref: string) => void;
	resetToDefaults: () => void;
	isBrowsing: boolean;
	hasOverride: boolean;
	branches: RuntimeGitRef[] | null;
	worktreeBranches: Map<string, string>;
	includeUncommitted: boolean;
	setIncludeUncommitted: (value: boolean) => void;
	threeDotDiff: boolean;
	setThreeDotDiff: (value: boolean) => void;
}

export function useGitViewCompare({
	selectedCard,
	currentProjectId,
	projectPath,
	homeGitSummary,
	board,
	isActive,
	pendingNavigation,
	onNavigationConsumed,
}: UseGitViewCompareOptions): UseGitViewCompareResult {
	const taskRepositoryInfo = useTaskRepositoryInfoValue(selectedCard?.card.id ?? null, selectedCard?.card.baseRef);
	const taskWorktreeSnapshot = useTaskWorktreeSnapshotValue(selectedCard?.card.id ?? null, selectedCard?.card.baseRef);

	// Default refs based on context
	const defaultSourceRef = useMemo(
		() =>
			resolveDefaultCompareSourceRef({
				selectedCard,
				projectPath,
				homeGitSummary,
				repositoryInfo: taskRepositoryInfo,
				worktreeSnapshot: taskWorktreeSnapshot,
			}),
		[selectedCard, projectPath, homeGitSummary, taskRepositoryInfo, taskWorktreeSnapshot],
	);

	const defaultTargetRef = useMemo(() => {
		if (selectedCard) {
			return selectedCard.card.baseRef;
		}
		return null;
	}, [selectedCard]);

	const [sourceRef, setSourceRefState] = useState<string | null>(defaultSourceRef);
	const [targetRef, setTargetRefState] = useState<string | null>(defaultTargetRef);

	const [includeUncommitted, setIncludeUncommitted] = useBooleanLocalStorageValue(
		LocalStorageKey.CompareIncludeUncommitted,
		true,
	);
	const [threeDotDiff, setThreeDotDiff] = useBooleanLocalStorageValue(LocalStorageKey.CompareThreeDotDiff, true);

	// Reset on task/project change
	useEffect(() => {
		setSourceRefState(defaultSourceRef);
		setTargetRefState(defaultTargetRef);
	}, [selectedCard?.card.id, currentProjectId, defaultSourceRef, defaultTargetRef]);

	// Apply external navigation requests (e.g. "compare against [branch]" from another component)
	useEffect(() => {
		if (!pendingNavigation) return;
		if (pendingNavigation.sourceRef) setSourceRefState(pendingNavigation.sourceRef);
		if (pendingNavigation.targetRef) setTargetRefState(pendingNavigation.targetRef);
		onNavigationConsumed?.();
	}, [pendingNavigation, onNavigationConsumed]);

	const setSourceRef = useCallback((ref: string) => setSourceRefState(ref), []);
	const setTargetRef = useCallback((ref: string) => setTargetRefState(ref), []);

	const resetToDefaults = useCallback(() => {
		setSourceRefState(defaultSourceRef);
		setTargetRefState(defaultTargetRef);
	}, [defaultSourceRef, defaultTargetRef]);

	const isBrowsing = sourceRef !== null && sourceRef !== defaultSourceRef;
	const hasOverride =
		(sourceRef !== null && sourceRef !== defaultSourceRef) || (targetRef !== null && targetRef !== defaultTargetRef);

	// Fetch git refs when compare tab is active
	const refsQueryFn = useCallback(async () => {
		if (!currentProjectId) {
			throw new Error("Missing project.");
		}
		const trpc = getRuntimeTrpcClient(currentProjectId);
		const taskScope = selectedCard?.card.id
			? { taskId: selectedCard.card.id, baseRef: selectedCard.card.baseRef }
			: null;
		const payload = await trpc.project.getGitRefs.query(taskScope);
		if (!payload.ok) {
			throw new Error(payload.error ?? "Could not load git refs.");
		}
		return payload;
	}, [currentProjectId, selectedCard?.card.id, selectedCard?.card.baseRef]);

	const refsQuery = useTrpcQuery<RuntimeGitRefsResponse>({
		enabled: isActive && currentProjectId !== null,
		queryFn: refsQueryFn,
		isDataEqual: areGitRefsResponsesEqual,
	});

	const branches = refsQuery.data?.refs ?? null;

	// Derive worktree branches map
	const worktreeBranches = useMemo(() => {
		const map = new Map<string, string>();
		for (const column of board.columns.filter((c) => c.id !== "trash")) {
			for (const card of column.cards) {
				if (card.branch && card.useWorktree !== false) {
					map.set(card.branch, card.title ?? card.id);
				}
			}
		}
		return map;
	}, [board]);

	return {
		sourceRef,
		targetRef,
		defaultSourceRef,
		defaultTargetRef,
		setSourceRef,
		setTargetRef,
		resetToDefaults,
		isBrowsing,
		hasOverride,
		branches,
		worktreeBranches,
		includeUncommitted,
		setIncludeUncommitted,
		threeDotDiff,
		setThreeDotDiff,
	};
}
