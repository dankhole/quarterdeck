import type { MouseEvent as ReactMouseEvent } from "react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { showAppToast } from "@/components/app-toaster";
import type { DiffLineComment } from "@/components/git/panels/diff-viewer-panel";
import {
	deriveActiveFiles,
	type GitViewTab,
	getLastSelectedPath,
	loadGitViewTab,
	persistGitViewTab,
	setLastSelectedPath,
} from "@/hooks/git/git-view";
import { type UseConflictResolutionResult, useConflictResolution } from "@/hooks/git/use-conflict-resolution";
import {
	type GitViewCompareNavigation,
	type UseGitViewCompareResult,
	useGitViewCompare,
} from "@/hooks/git/use-git-view-compare";
import { useDocumentVisibility } from "@/hooks/notifications/use-document-visibility";
import { clampBetween } from "@/resize/resize-persistence";
import {
	loadResizePreference,
	persistResizePreference,
	type ResizeNumberPreference,
} from "@/resize/resize-preferences";
import { useResizeDrag } from "@/resize/use-resize-drag";
import { getRuntimeTrpcClient } from "@/runtime/trpc-client";
import type { RuntimeGitSyncSummary, RuntimeTaskSessionSummary, RuntimeWorkspaceFileChange } from "@/runtime/types";
import { type FileLoadingState, useAllFileDiffContent } from "@/runtime/use-all-file-diff-content";
import { useRuntimeWorkspaceChanges } from "@/runtime/use-runtime-workspace-changes";
import { LocalStorageKey } from "@/storage/local-storage-store";
import { useTaskWorkspaceStateVersionValue } from "@/stores/workspace-metadata-store";
import type { BoardData, CardSelection } from "@/types";

const POLL_INTERVAL_MS = 1_000;

const GIT_VIEW_FILE_TREE_RATIO_PREFERENCE: ResizeNumberPreference = {
	key: LocalStorageKey.GitViewFileTreeRatio,
	defaultValue: 0.22,
	normalize: (value) => clampBetween(value, 0.12, 0.5),
};

export interface UseGitViewOptions {
	currentProjectId: string | null;
	selectedCard: CardSelection | null;
	sessionSummary: RuntimeTaskSessionSummary | null;
	homeGitSummary?: RuntimeGitSyncSummary | null;
	board?: BoardData;
	pendingCompareNavigation?: GitViewCompareNavigation | null;
	onCompareNavigationConsumed?: () => void;
	pendingFileNavigation?: { targetView: "git" | "files"; filePath: string } | null;
	onFileNavigationConsumed?: () => void;
}

export function useGitView({
	currentProjectId,
	selectedCard,
	sessionSummary,
	homeGitSummary = null,
	board = { columns: [], dependencies: [] },
	pendingCompareNavigation,
	onCompareNavigationConsumed,
	pendingFileNavigation,
	onFileNavigationConsumed,
}: UseGitViewOptions): UseGitViewResult {
	const [activeTab, setActiveTabState] = useState<GitViewTab>(loadGitViewTab);
	const [fileTreeVisible, setFileTreeVisible] = useState(true);
	const [fileTreeRatio, setFileTreeRatioState] = useState(() =>
		loadResizePreference(GIT_VIEW_FILE_TREE_RATIO_PREFERENCE),
	);
	const [selectedPath, setSelectedPathRaw] = useState<string | null>(null);
	const [diffComments, setDiffComments] = useState<Map<string, DiffLineComment>>(new Map());

	const contentRowRef = useRef<HTMLDivElement | null>(null);
	const pendingCompareNavigationRef = useRef(pendingCompareNavigation);
	pendingCompareNavigationRef.current = pendingCompareNavigation;
	const { startDrag: startFileTreeResize } = useResizeDrag();
	const isDocumentVisible = useDocumentVisibility();

	const taskId = selectedCard?.card.id ?? null;

	// --- Selected path with persistence ---

	const setSelectedPath = useCallback(
		(path: string | null) => {
			setSelectedPathRaw(path);
			if (path) {
				setLastSelectedPath(taskId, activeTab, path);
			}
		},
		[taskId, activeTab],
	);

	// --- Conflict resolution ---

	const conflictResolution = useConflictResolution({
		taskId,
		workspaceId: currentProjectId,
	});

	// --- Resize ---

	const setFileTreeRatio = useCallback((ratio: number) => {
		setFileTreeRatioState(persistResizePreference(GIT_VIEW_FILE_TREE_RATIO_PREFERENCE, ratio));
	}, []);

	const handleFileTreeSeparatorMouseDown = useMemo(() => {
		return (event: ReactMouseEvent<HTMLDivElement>) => {
			const container = contentRowRef.current;
			if (!container) return;
			const containerWidth = Math.max(container.offsetWidth, 1);
			const startX = event.clientX;
			const currentRatio = fileTreeRatio;
			startFileTreeResize(event, {
				axis: "x",
				cursor: "ew-resize",
				onMove: (pointerX) => setFileTreeRatio(currentRatio + (pointerX - startX) / containerWidth),
				onEnd: (pointerX) => setFileTreeRatio(currentRatio + (pointerX - startX) / containerWidth),
			});
		};
	}, [fileTreeRatio, setFileTreeRatio, startFileTreeResize]);

	const fileTreePercent = `${(fileTreeRatio * 100).toFixed(1)}%`;
	const contentPercent = `${((1 - fileTreeRatio) * 100).toFixed(1)}%`;

	// --- Tab management ---

	const setActiveTab = useCallback((tab: GitViewTab) => {
		setActiveTabState(tab);
		persistGitViewTab(tab);
	}, []);

	// --- Data fetching ---

	const baseRef = selectedCard?.card.baseRef ?? null;
	const taskWorkspaceStateVersion = useTaskWorkspaceStateVersionValue(taskId);

	// Uncommitted tab data
	const isUncommittedActive = activeTab === "uncommitted";
	const { changes: uncommittedChanges, isRuntimeAvailable: uncommittedAvailable } = useRuntimeWorkspaceChanges(
		isUncommittedActive ? (taskId ?? null) : null,
		isUncommittedActive ? currentProjectId : null,
		isUncommittedActive ? baseRef : null,
		"working_copy",
		taskWorkspaceStateVersion,
		isUncommittedActive && isDocumentVisible ? POLL_INTERVAL_MS : null,
	);

	// Last Turn tab data
	const isLastTurnActive = activeTab === "last_turn";
	const lastTurnViewKey = useMemo(() => {
		if (!isLastTurnActive || !sessionSummary) return null;
		return [
			sessionSummary.state ?? "none",
			sessionSummary.latestTurnCheckpoint?.commit ?? "none",
			sessionSummary.previousTurnCheckpoint?.commit ?? "none",
		].join(":");
	}, [isLastTurnActive, sessionSummary]);

	const { changes: lastTurnChanges, isRuntimeAvailable: lastTurnAvailable } = useRuntimeWorkspaceChanges(
		isLastTurnActive ? taskId : null,
		isLastTurnActive ? currentProjectId : null,
		isLastTurnActive ? baseRef : null,
		"last_turn",
		taskWorkspaceStateVersion,
		isLastTurnActive && isDocumentVisible ? POLL_INTERVAL_MS : null,
		lastTurnViewKey,
		true,
	);

	// Switch to compare tab when external navigation arrives
	useEffect(() => {
		if (pendingCompareNavigation) {
			setActiveTab("compare");
		}
	}, [pendingCompareNavigation, setActiveTab]);

	// Navigate to a specific file when external file navigation arrives (from commit panel)
	useEffect(() => {
		if (pendingFileNavigation?.targetView === "git") {
			setActiveTab("uncommitted");
			setSelectedPathRaw(pendingFileNavigation.filePath);
			onFileNavigationConsumed?.();
		}
	}, [pendingFileNavigation, onFileNavigationConsumed, setActiveTab]);

	// Compare tab state
	const isCompareActive = activeTab === "compare";
	const compare = useGitViewCompare({
		selectedCard,
		currentProjectId,
		homeGitSummary,
		board,
		isActive: isCompareActive,
		pendingNavigation: pendingCompareNavigation,
		onNavigationConsumed: onCompareNavigationConsumed,
	});

	const hasCompareRefs = !!compare.sourceRef && !!compare.targetRef;
	const compareIncludeUncommitted = compare.includeUncommitted;
	const compareThreeDot = compare.threeDotDiff;
	const compareDiffMode = compareThreeDot ? ("three_dot" as const) : ("two_dot" as const);
	const comparePollInterval =
		isCompareActive && compareIncludeUncommitted && isDocumentVisible ? POLL_INTERVAL_MS : null;
	const { changes: compareChanges, isRuntimeAvailable: compareAvailable } = useRuntimeWorkspaceChanges(
		isCompareActive && hasCompareRefs ? (taskId ?? null) : null,
		isCompareActive && hasCompareRefs ? currentProjectId : null,
		isCompareActive ? baseRef : null,
		"working_copy",
		taskWorkspaceStateVersion,
		comparePollInterval,
		isCompareActive
			? `compare:${compare.sourceRef}:${compare.targetRef}:${compareIncludeUncommitted ? "wt" : "refs"}:${compareDiffMode}`
			: null,
		true,
		compare.targetRef,
		compareIncludeUncommitted ? undefined : compare.sourceRef,
		compareDiffMode,
	);

	// Derive active file list for file tree
	const activeFiles: RuntimeWorkspaceFileChange[] | null = useMemo(
		() => deriveActiveFiles(activeTab, uncommittedChanges?.files, lastTurnChanges?.files, compareChanges?.files),
		[activeTab, uncommittedChanges, lastTurnChanges, compareChanges],
	);

	// Batch diff content loading
	const { enrichedFiles, fileLoadingState } = useAllFileDiffContent({
		workspaceId: currentProjectId,
		taskId,
		baseRef,
		mode: activeTab === "last_turn" ? "last_turn" : "working_copy",
		fromRef: activeTab === "compare" ? compare.targetRef : undefined,
		toRef: activeTab === "compare" && !compareIncludeUncommitted ? compare.sourceRef : undefined,
		diffMode: activeTab === "compare" ? compareDiffMode : undefined,
		files: activeFiles,
	});

	const isRuntimeAvailable =
		activeTab === "uncommitted"
			? uncommittedAvailable
			: activeTab === "last_turn"
				? lastTurnAvailable
				: compareAvailable;
	const isChangesPending = isRuntimeAvailable && activeFiles === null && !(activeTab === "compare" && !hasCompareRefs);
	const hasNoChanges = isRuntimeAvailable && activeFiles !== null && activeFiles.length === 0;

	// Auto-select file when file list changes
	const availablePaths = useMemo(() => {
		if (!activeFiles || activeFiles.length === 0) return [];
		return activeFiles.map((file) => file.path);
	}, [activeFiles]);

	useEffect(() => {
		if (selectedPath && availablePaths.includes(selectedPath)) return;
		const remembered = getLastSelectedPath(taskId, activeTab);
		if (remembered && availablePaths.includes(remembered)) {
			setSelectedPathRaw(remembered);
			return;
		}
		setSelectedPathRaw(availablePaths[0] ?? null);
	}, [availablePaths, selectedPath, taskId, activeTab]);

	// --- File rollback (uncommitted tab only) ---

	const taskScope = useMemo(() => (taskId && baseRef ? { taskId, baseRef } : null), [taskId, baseRef]);
	const isRollingBackRef = useRef(false);

	const handleRollbackFile = useCallback(
		async (path: string) => {
			if (!currentProjectId || isRollingBackRef.current) return;
			const file = uncommittedChanges?.files?.find((f) => f.path === path);
			if (!file) return;
			isRollingBackRef.current = true;
			try {
				const trpcClient = getRuntimeTrpcClient(currentProjectId);
				const result = await trpcClient.workspace.discardFile.mutate({
					taskScope,
					path,
					fileStatus: file.status,
				});
				if (result.ok) {
					showAppToast({
						intent: "success",
						message: `Discarded changes to ${path.split("/").pop()}`,
						timeout: 4000,
					});
				} else {
					showAppToast({ intent: "danger", message: result.error ?? "Rollback failed.", timeout: 7000 });
				}
			} catch (error) {
				showAppToast({
					intent: "danger",
					message: error instanceof Error ? error.message : "Rollback failed.",
					timeout: 7000,
				});
			} finally {
				isRollingBackRef.current = false;
			}
		},
		[currentProjectId, taskScope, uncommittedChanges?.files],
	);

	// --- Reset on context switches ---

	useEffect(() => {
		setSelectedPathRaw(getLastSelectedPath(taskId, activeTab) ?? null);
		setDiffComments(new Map());
	}, [taskId, activeTab]);

	useEffect(() => {
		setSelectedPathRaw(null);
		if (!pendingCompareNavigationRef.current) {
			setActiveTab("uncommitted");
		}
		setDiffComments(new Map());
	}, [currentProjectId, setActiveTab]);

	return {
		activeTab,
		setActiveTab,
		fileTreeVisible,
		setFileTreeVisible,
		fileTreePercent,
		contentPercent,
		contentRowRef,
		handleFileTreeSeparatorMouseDown,
		selectedPath,
		setSelectedPath,
		diffComments,
		setDiffComments,
		conflictResolution,
		compare,
		hasCompareRefs,
		activeFiles,
		enrichedFiles,
		fileLoadingState,
		isRuntimeAvailable,
		isChangesPending,
		hasNoChanges,
		handleRollbackFile,
		selectedCard,
	};
}

export interface UseGitViewResult {
	activeTab: GitViewTab;
	setActiveTab: (tab: GitViewTab) => void;
	fileTreeVisible: boolean;
	setFileTreeVisible: React.Dispatch<React.SetStateAction<boolean>>;
	fileTreePercent: string;
	contentPercent: string;
	contentRowRef: React.MutableRefObject<HTMLDivElement | null>;
	handleFileTreeSeparatorMouseDown: (event: ReactMouseEvent<HTMLDivElement>) => void;
	selectedPath: string | null;
	setSelectedPath: (path: string | null) => void;
	diffComments: Map<string, DiffLineComment>;
	setDiffComments: React.Dispatch<React.SetStateAction<Map<string, DiffLineComment>>>;
	conflictResolution: UseConflictResolutionResult;
	compare: UseGitViewCompareResult;
	hasCompareRefs: boolean;
	activeFiles: RuntimeWorkspaceFileChange[] | null;
	enrichedFiles: RuntimeWorkspaceFileChange[] | null;
	fileLoadingState: FileLoadingState;
	isRuntimeAvailable: boolean;
	isChangesPending: boolean;
	hasNoChanges: boolean;
	handleRollbackFile: (path: string) => Promise<void>;
	selectedCard: CardSelection | null;
}
