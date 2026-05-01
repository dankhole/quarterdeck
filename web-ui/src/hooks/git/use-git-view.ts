import type { MouseEvent as ReactMouseEvent } from "react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { showAppToast } from "@/components/app-toaster";
import type { DiffLineComment } from "@/components/git/panels/diff-viewer-panel";
import { arePathListsEqual } from "@/hooks/git/git-diff-data";
import {
	type GitViewTab,
	getLastSelectedPath,
	isTaskBaseRefResolved,
	loadGitViewTab,
	persistGitViewTab,
	setLastSelectedPath,
} from "@/hooks/git/git-view";
import { type UseConflictResolutionResult, useConflictResolution } from "@/hooks/git/use-conflict-resolution";
import { useGitDiffData } from "@/hooks/git/use-git-diff-data";
import {
	type GitViewCompareNavigation,
	type UseGitViewCompareResult,
	useGitViewCompare,
} from "@/hooks/git/use-git-view-compare";
import { clampBetween } from "@/resize/resize-persistence";
import {
	loadResizePreference,
	persistResizePreference,
	type ResizeNumberPreference,
} from "@/resize/resize-preferences";
import { useResizeDrag } from "@/resize/use-resize-drag";
import { getRuntimeTrpcClient } from "@/runtime/trpc-client";
import type { RuntimeGitSyncSummary, RuntimeTaskSessionSummary, RuntimeWorkdirFileChange } from "@/runtime/types";
import type { FileLoadingState } from "@/runtime/use-all-file-diff-content";
import { LocalStorageKey } from "@/storage/local-storage-store";
import type { BoardData, CardSelection } from "@/types";

const GIT_VIEW_FILE_TREE_RATIO_PREFERENCE: ResizeNumberPreference = {
	key: LocalStorageKey.GitViewFileTreeRatio,
	defaultValue: 0.22,
	normalize: (value) => clampBetween(value, 0.12, 0.5),
};

export interface UseGitViewOptions {
	currentProjectId: string | null;
	selectedCard: CardSelection | null;
	sessionSummary: RuntimeTaskSessionSummary | null;
	projectPath?: string | null;
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
	projectPath,
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
	const [visibleDiffPaths, setVisibleDiffPaths] = useState<readonly string[]>([]);
	const [diffComments, setDiffComments] = useState<Map<string, DiffLineComment>>(new Map());

	const contentRowRef = useRef<HTMLDivElement | null>(null);
	const pendingCompareNavigationRef = useRef(pendingCompareNavigation);
	pendingCompareNavigationRef.current = pendingCompareNavigation;
	const { startDrag: startFileTreeResize } = useResizeDrag();

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
		projectId: currentProjectId,
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
		projectPath,
		homeGitSummary,
		board,
		isActive: isCompareActive,
		pendingNavigation: pendingCompareNavigation,
		onNavigationConsumed: onCompareNavigationConsumed,
	});

	const handleVisibleDiffPathsChange = useCallback((paths: string[]) => {
		setVisibleDiffPaths((previous) => (arePathListsEqual(previous, paths) ? previous : paths));
	}, []);

	const {
		hasCompareRefs,
		activeFiles,
		enrichedFiles,
		fileLoadingState,
		isRuntimeAvailable,
		isChangesPending,
		hasNoChanges,
		uncommittedChanges,
	} = useGitDiffData({
		activeTab,
		currentProjectId,
		taskId,
		baseRef,
		sessionSummary,
		selectedPath,
		visibleDiffPaths,
		compare,
	});

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

	const taskScope = useMemo(() => (taskId ? { taskId, baseRef: baseRef ?? "" } : null), [taskId, baseRef]);
	const isRollingBackRef = useRef(false);

	const handleRollbackFile = useCallback(
		async (path: string) => {
			if (!currentProjectId || isRollingBackRef.current || !isTaskBaseRefResolved(taskId, baseRef)) return;
			const file = uncommittedChanges?.files?.find((f) => f.path === path);
			if (!file) return;
			isRollingBackRef.current = true;
			try {
				const trpcClient = getRuntimeTrpcClient(currentProjectId);
				const result = await trpcClient.project.discardFile.mutate({
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
		[currentProjectId, taskId, baseRef, taskScope, uncommittedChanges?.files],
	);

	// --- Reset on context switches ---

	useEffect(() => {
		setSelectedPathRaw(getLastSelectedPath(taskId, activeTab) ?? null);
		setVisibleDiffPaths([]);
		setDiffComments(new Map());
	}, [taskId, activeTab]);

	useEffect(() => {
		setSelectedPathRaw(null);
		setVisibleDiffPaths([]);
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
		handleVisibleDiffPathsChange,
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
	handleVisibleDiffPathsChange: (paths: string[]) => void;
	diffComments: Map<string, DiffLineComment>;
	setDiffComments: React.Dispatch<React.SetStateAction<Map<string, DiffLineComment>>>;
	conflictResolution: UseConflictResolutionResult;
	compare: UseGitViewCompareResult;
	hasCompareRefs: boolean;
	activeFiles: RuntimeWorkdirFileChange[] | null;
	enrichedFiles: RuntimeWorkdirFileChange[] | null;
	fileLoadingState: FileLoadingState;
	isRuntimeAvailable: boolean;
	isChangesPending: boolean;
	hasNoChanges: boolean;
	handleRollbackFile: (path: string) => Promise<void>;
	selectedCard: CardSelection | null;
}
