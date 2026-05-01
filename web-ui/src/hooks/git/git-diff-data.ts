import type { RuntimeTaskSessionSummary, RuntimeWorkdirChangesResponse } from "@/runtime/types";
import type { GitViewTab } from "./git-view";

export function arePathListsEqual(previous: readonly string[], next: readonly string[]): boolean {
	return previous.length === next.length && previous.every((path, index) => path === next[index]);
}

export function createLastTurnDiffViewKey(
	isLastTurnActive: boolean,
	sessionSummary: RuntimeTaskSessionSummary | null,
): string | null {
	if (!isLastTurnActive || !sessionSummary) return null;
	return [
		sessionSummary.state ?? "none",
		sessionSummary.latestTurnCheckpoint?.commit ?? "none",
		sessionSummary.previousTurnCheckpoint?.commit ?? "none",
	].join(":");
}

export function createCompareDiffViewKey(input: {
	isCompareActive: boolean;
	sourceRef: string | null;
	targetRef: string | null;
	includeUncommitted: boolean;
	diffMode: "two_dot" | "three_dot";
}): string | null {
	if (!input.isCompareActive) return null;
	return `compare:${input.sourceRef}:${input.targetRef}:${input.includeUncommitted ? "wt" : "refs"}:${input.diffMode}`;
}

export function deriveDiffPriorityPaths(
	selectedPath: string | null,
	visibleDiffPaths: readonly string[],
): readonly string[] {
	const paths: string[] = [];
	const seen = new Set<string>();
	const addPath = (path: string | null | undefined) => {
		if (!path || seen.has(path)) {
			return;
		}
		seen.add(path);
		paths.push(path);
	};
	addPath(selectedPath);
	for (const path of visibleDiffPaths) {
		addPath(path);
	}
	return paths;
}

export function getActiveFilesRevision(
	activeTab: GitViewTab,
	uncommittedChanges: RuntimeWorkdirChangesResponse | null,
	lastTurnChanges: RuntimeWorkdirChangesResponse | null,
	compareChanges: RuntimeWorkdirChangesResponse | null,
): number | null {
	if (activeTab === "uncommitted") return uncommittedChanges?.generatedAt ?? null;
	if (activeTab === "last_turn") return lastTurnChanges?.generatedAt ?? null;
	return compareChanges?.generatedAt ?? null;
}

export function resolveGitDiffRuntimeAvailable(input: {
	activeTab: GitViewTab;
	uncommittedAvailable: boolean;
	lastTurnAvailable: boolean;
	compareAvailable: boolean;
}): boolean {
	if (input.activeTab === "uncommitted") return input.uncommittedAvailable;
	if (input.activeTab === "last_turn") return input.lastTurnAvailable;
	return input.compareAvailable;
}

export function isGitDiffChangesPending(input: {
	activeTab: GitViewTab;
	hasCompareRefs: boolean;
	isRuntimeAvailable: boolean;
	activeFiles: readonly unknown[] | null;
}): boolean {
	return (
		input.isRuntimeAvailable &&
		input.activeFiles === null &&
		!(input.activeTab === "compare" && !input.hasCompareRefs)
	);
}
