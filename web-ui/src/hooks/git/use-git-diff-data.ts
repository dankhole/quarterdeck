import { useMemo } from "react";

import { useDocumentVisibility } from "@/hooks/notifications/use-document-visibility";
import type {
	RuntimeDiffMode,
	RuntimeTaskSessionSummary,
	RuntimeWorkdirChangesResponse,
	RuntimeWorkdirFileChange,
} from "@/runtime/types";
import { type FileLoadingState, useAllFileDiffContent } from "@/runtime/use-all-file-diff-content";
import { useRuntimeProjectChanges } from "@/runtime/use-runtime-project-changes";
import { useTaskWorktreeStateVersionValue } from "@/stores/project-metadata-store";
import {
	createCompareDiffViewKey,
	createLastTurnDiffViewKey,
	deriveDiffPriorityPaths,
	getActiveFilesRevision,
	isGitDiffChangesPending,
	resolveGitDiffRuntimeAvailable,
} from "./git-diff-data";
import { deriveActiveFiles, type GitViewTab, resolveGitChangesQueryProjectId } from "./git-view";
import type { UseGitViewCompareResult } from "./use-git-view-compare";

const POLL_INTERVAL_MS = 1_000;

export interface UseGitDiffDataOptions {
	readonly activeTab: GitViewTab;
	readonly currentProjectId: string | null;
	readonly taskId: string | null;
	readonly baseRef: string | null;
	readonly sessionSummary: RuntimeTaskSessionSummary | null;
	readonly selectedPath: string | null;
	readonly visibleDiffPaths: readonly string[];
	readonly compare: UseGitViewCompareResult;
}

export interface UseGitDiffDataResult {
	readonly hasCompareRefs: boolean;
	readonly activeFiles: RuntimeWorkdirFileChange[] | null;
	readonly enrichedFiles: RuntimeWorkdirFileChange[] | null;
	readonly fileLoadingState: FileLoadingState;
	readonly isRuntimeAvailable: boolean;
	readonly isChangesPending: boolean;
	readonly hasNoChanges: boolean;
	readonly uncommittedChanges: RuntimeWorkdirChangesResponse | null;
}

export function useGitDiffData(options: UseGitDiffDataOptions): UseGitDiffDataResult {
	const { activeTab, currentProjectId, taskId, baseRef, sessionSummary, selectedPath, visibleDiffPaths, compare } =
		options;
	const isDocumentVisible = useDocumentVisibility();
	const taskWorktreeStateVersion = useTaskWorktreeStateVersionValue(taskId);
	const baseDerivedProjectId = resolveGitChangesQueryProjectId({
		currentProjectId,
		taskId,
		baseRef,
		refMode: "base_derived",
	});

	const isUncommittedActive = activeTab === "uncommitted";
	const { changes: uncommittedChanges, isRuntimeAvailable: uncommittedAvailable } = useRuntimeProjectChanges(
		isUncommittedActive ? (taskId ?? null) : null,
		isUncommittedActive ? baseDerivedProjectId : null,
		isUncommittedActive ? baseRef : null,
		"working_copy",
		taskWorktreeStateVersion,
		isUncommittedActive && isDocumentVisible ? POLL_INTERVAL_MS : null,
	);

	const isLastTurnActive = activeTab === "last_turn";
	const lastTurnViewKey = useMemo(
		() => createLastTurnDiffViewKey(isLastTurnActive, sessionSummary),
		[isLastTurnActive, sessionSummary],
	);
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

	const isCompareActive = activeTab === "compare";
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
	const compareDiffMode: RuntimeDiffMode = compare.threeDotDiff ? "three_dot" : "two_dot";
	const comparePollInterval =
		isCompareActive && compareIncludeUncommitted && isDocumentVisible ? POLL_INTERVAL_MS : null;
	const compareViewKey = useMemo(
		() =>
			createCompareDiffViewKey({
				isCompareActive,
				sourceRef: compare.sourceRef,
				targetRef: compare.targetRef,
				includeUncommitted: compareIncludeUncommitted,
				diffMode: compareDiffMode,
			}),
		[compare.sourceRef, compare.targetRef, compareDiffMode, compareIncludeUncommitted, isCompareActive],
	);
	const { changes: compareChanges, isRuntimeAvailable: compareAvailable } = useRuntimeProjectChanges(
		isCompareActive && hasCompareRefs ? (taskId ?? null) : null,
		isCompareActive && hasCompareRefs ? compareProjectId : null,
		isCompareActive ? baseRef : null,
		"working_copy",
		taskWorktreeStateVersion,
		comparePollInterval,
		compareViewKey,
		true,
		compare.targetRef,
		compareIncludeUncommitted ? undefined : compare.sourceRef,
		compareDiffMode,
	);

	const uncommittedFiles = uncommittedChanges?.files ?? null;
	const lastTurnFiles = lastTurnChanges?.files ?? null;
	const compareFiles = compareChanges?.files ?? null;
	const activeFiles: RuntimeWorkdirFileChange[] | null = useMemo(
		() => deriveActiveFiles(activeTab, uncommittedFiles, lastTurnFiles, compareFiles),
		[activeTab, uncommittedFiles, lastTurnFiles, compareFiles],
	);
	const activeFilesRevision = getActiveFilesRevision(activeTab, uncommittedChanges, lastTurnChanges, compareChanges);
	const diffPriorityPaths = useMemo(
		() => deriveDiffPriorityPaths(selectedPath, visibleDiffPaths),
		[selectedPath, visibleDiffPaths],
	);

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
		priorityPaths: diffPriorityPaths,
	});

	const isRuntimeAvailable = resolveGitDiffRuntimeAvailable({
		activeTab,
		uncommittedAvailable,
		lastTurnAvailable,
		compareAvailable,
	});
	const isChangesPending = isGitDiffChangesPending({
		activeTab,
		hasCompareRefs,
		isRuntimeAvailable,
		activeFiles,
	});
	const hasNoChanges = isRuntimeAvailable && activeFiles !== null && activeFiles.length === 0;

	return {
		hasCompareRefs,
		activeFiles,
		enrichedFiles,
		fileLoadingState,
		isRuntimeAvailable,
		isChangesPending,
		hasNoChanges,
		uncommittedChanges,
	};
}
