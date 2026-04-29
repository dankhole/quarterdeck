import type { MouseEvent as ReactMouseEvent } from "react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { showAppToast } from "@/components/app-toaster";
import type { DiffLineComment } from "@/components/git/panels/diff-viewer-panel";
import {
	deriveActiveFiles,
	type GitViewTab,
	getLastSelectedPath,
	isTaskBaseRefResolved,
	loadGitViewTab,
	persistGitViewTab,
	resolveGitChangesQueryProjectId,
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
import type { RuntimeGitSyncSummary, RuntimeTaskSessionSummary, RuntimeWorkdirFileChange } from "@/runtime/types";
import { type FileLoadingState, useAllFileDiffContent } from "@/runtime/use-all-file-diff-content";
import { useRuntimeProjectChanges } from "@/runtime/use-runtime-project-changes";
import { LocalStorageKey } from "@/storage/local-storage-store";
import { useTaskWorktreeStateVersionValue } from "@/stores/project-metadata-store";
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
	const baseDerivedProjectId = resolveGitChangesQueryProjectId({
		currentProjectId,
		taskId,
		baseRef,
		refMode: "base_derived",
	});
	const taskWorktreeStateVersion = useTaskWorktreeStateVersionValue(taskId);

	// Uncommitted tab data
	const isUncommittedActive = activeTab === "uncommitted";
	const { changes: uncommittedChanges, isRuntimeAvailable: uncommittedAvailable } = useRuntimeProjectChanges(
		isUncommittedActive ? (taskId ?? null) : null,
		isUncommittedActive ? baseDerivedProjectId : null,
		isUncommittedActive ? baseRef : null,
		"working_copy",
		taskWorktreeStateVersion,
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

	const { changes: lastTurnChanges, isRuntimeAvailable: lastTurnAvailable } = useRuntimeProjectChanges(
		isLastTurnActive ? taskId : null,
		isLastTurnActive ? baseDerivedProjectId : null,
		isLastTurnActive ? baseRef : null,
		"last_turn",
		taskWorktreeStateVersion,
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
		projectPath,
		homeGitSummary,
		board,
		isActive: isCompareActive,
		pendingNavigation: pendingCompareNavigation,
		onNavigationConsumed: onCompareNavigationConsumed,
	});

	const hasCompareRefs = !!compare.sourceRef && !!compare.targetRef;
	const compareProjectId = hasCompareRefs
		? resolveGitChangesQueryProjectId({
				currentProjectId,
				taskId,
				baseRef,
				refMode: "explicit_refs",
			})
		: null;
	const compareIncludeUncommitted = compare.includeUncommitted;
	const compareThreeDot = compare.threeDotDiff;
	const compareDiffMode = compareThreeDot ? ("three_dot" as const) : ("two_dot" as const);
	const comparePollInterval =
		isCompareActive && compareIncludeUncommitted && isDocumentVisible ? POLL_INTERVAL_MS : null;
	const { changes: compareChanges, isRuntimeAvailable: compareAvailable } = useRuntimeProjectChanges(
		isCompareActive && hasCompareRefs ? (taskId ?? null) : null,
		isCompareActive && hasCompareRefs ? compareProjectId : null,
		isCompareActive ? baseRef : null,
		"working_copy",
		taskWorktreeStateVersion,
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
	const uncommittedFiles = uncommittedChanges?.files ?? null;
	const lastTurnFiles = lastTurnChanges?.files ?? null;
	const compareFiles = compareChanges?.files ?? null;
	const activeFiles: RuntimeWorkdirFileChange[] | null = useMemo(
		() => deriveActiveFiles(activeTab, uncommittedFiles, lastTurnFiles, compareFiles),
		[activeTab, uncommittedFiles, lastTurnFiles, compareFiles],
	);
	const activeFilesRevision =
		activeTab === "uncommitted"
			? (uncommittedChanges?.generatedAt ?? null)
			: activeTab === "last_turn"
				? (lastTurnChanges?.generatedAt ?? null)
				: (compareChanges?.generatedAt ?? null);

	// Batch diff content loading
	const { enrichedFiles, fileLoadingState } = useAllFileDiffContent({
		projectId: activeTab === "compare" ? compareProjectId : baseDerivedProjectId,
		taskId,
		baseRef,
		mode: activeTab === "last_turn" ? "last_turn" : "working_copy",
		fromRef: activeTab === "compare" ? compare.targetRef : undefined,
		toRef: activeTab === "compare" && !compareIncludeUncommitted ? compare.sourceRef : undefined,
		diffMode: activeTab === "compare" ? compareDiffMode : undefined,
		files: activeFiles,
		filesRevision: activeFilesRevision,
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
	activeFiles: RuntimeWorkdirFileChange[] | null;
	enrichedFiles: RuntimeWorkdirFileChange[] | null;
	fileLoadingState: FileLoadingState;
	isRuntimeAvailable: boolean;
	isChangesPending: boolean;
	hasNoChanges: boolean;
	handleRollbackFile: (path: string) => Promise<void>;
	selectedCard: CardSelection | null;
}
