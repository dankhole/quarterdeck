import { useCallback, useEffect, useMemo, useSyncExternalStore } from "react";
import { areGitRefsResponsesEqual } from "@/runtime/query-equality";
import { getRuntimeTrpcClient } from "@/runtime/trpc-client";
import type { RuntimeGitRef, RuntimeGitRefsResponse, RuntimeGitSyncSummary } from "@/runtime/types";
import { useTrpcQuery } from "@/runtime/use-trpc-query";
import {
	createGitCompareSelectionKey,
	type GitCompareSelection,
	gitCompareSelections,
} from "@/state/git-compare-selections";
import { LocalStorageKey } from "@/storage/local-storage-store";
import { useTaskRepositoryInfoValue, useTaskWorktreeSnapshotValue } from "@/stores/project-metadata-store";
import type { BoardData, CardSelection } from "@/types";
import { useBooleanLocalStorageValue } from "@/utils/react-use";
import { resolveDefaultCompareSourceRef } from "./git-view-compare";
import { useWorktreeBranches } from "./use-worktree-branches";

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

	// Existing preferences seed newly visited scopes; restored selections never write them back.
	const [defaultIncludeUncommitted, setDefaultIncludeUncommitted] = useBooleanLocalStorageValue(
		LocalStorageKey.CompareIncludeUncommitted,
		true,
	);
	const [defaultThreeDotDiff, setDefaultThreeDotDiff] = useBooleanLocalStorageValue(
		LocalStorageKey.CompareThreeDotDiff,
		true,
	);
	const selectionKey = createGitCompareSelectionKey(
		currentProjectId,
		selectedCard?.card.id ?? null,
		selectedCard?.card.createdAt,
	);
	const initialSelection = useMemo<GitCompareSelection>(
		() => ({
			includeUncommitted: defaultIncludeUncommitted,
			threeDotDiff: defaultThreeDotDiff,
		}),
		[defaultIncludeUncommitted, defaultThreeDotDiff],
	);
	const subscribe = useCallback(
		(listener: () => void) => gitCompareSelections.subscribe(selectionKey, listener),
		[selectionKey],
	);
	const getSnapshot = useCallback(
		() => gitCompareSelections.get(selectionKey) ?? initialSelection,
		[selectionKey, initialSelection],
	);
	const selection = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
	useEffect(() => {
		gitCompareSelections.initialize(selectionKey, initialSelection);
	}, [selectionKey, initialSelection]);

	const sourceRef = selection.sourceRefOverride ?? defaultSourceRef;
	const targetRef = selection.targetRefOverride ?? defaultTargetRef;
	const { includeUncommitted, threeDotDiff } = selection;
	const setSourceRef = useCallback(
		(ref: string) => {
			gitCompareSelections.update(selectionKey, initialSelection, { sourceRefOverride: ref });
		},
		[selectionKey, initialSelection],
	);
	const setTargetRef = useCallback(
		(ref: string) => {
			gitCompareSelections.update(selectionKey, initialSelection, { targetRefOverride: ref });
		},
		[selectionKey, initialSelection],
	);
	const setIncludeUncommitted = useCallback(
		(value: boolean) => {
			gitCompareSelections.update(selectionKey, initialSelection, { includeUncommitted: value });
			setDefaultIncludeUncommitted(value);
		},
		[selectionKey, initialSelection, setDefaultIncludeUncommitted],
	);
	const setThreeDotDiff = useCallback(
		(value: boolean) => {
			gitCompareSelections.update(selectionKey, initialSelection, { threeDotDiff: value });
			setDefaultThreeDotDiff(value);
		},
		[selectionKey, initialSelection, setDefaultThreeDotDiff],
	);

	// External navigation overrides only its supplied refs, including a restored selection.
	useEffect(() => {
		if (!pendingNavigation) return;
		if (pendingNavigation.sourceRef) setSourceRef(pendingNavigation.sourceRef);
		if (pendingNavigation.targetRef) setTargetRef(pendingNavigation.targetRef);
		onNavigationConsumed?.();
	}, [pendingNavigation, onNavigationConsumed, setSourceRef, setTargetRef]);

	const resetToDefaults = useCallback(() => {
		gitCompareSelections.update(selectionKey, initialSelection, {
			sourceRefOverride: undefined,
			targetRefOverride: undefined,
		});
	}, [selectionKey, initialSelection]);

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

	const worktreeBranches = useWorktreeBranches(currentProjectId, board);

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
