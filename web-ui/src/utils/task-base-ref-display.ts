import {
	type RuntimeTaskBaseRefInput,
	type RuntimeTaskBaseRefState,
	resolveRuntimeTaskBaseRefState,
} from "@runtime-contract";

export interface TaskBaseRefDisplayState {
	baseRefState: RuntimeTaskBaseRefState;
	triggerLabel: string;
	behindLabel: string | null;
	isBehind: boolean;
	pinToggleLabel: string | null;
}

export interface DetachedWorktreeDisplayInput {
	baseRef: string | null | undefined;
	headCommit?: string | null | undefined;
}

export interface DetachedTaskWorktreeDisplayInput extends DetachedWorktreeDisplayInput {
	isDetached: boolean;
	isAssignedShared: boolean;
}

export interface DetachedWorktreeDisplayState {
	baseRef: string;
	headCommit: string | null;
	label: string;
	tooltip: string;
}

function formatShortCommit(headCommit: string | null | undefined): string | null {
	const trimmed = headCommit?.trim();
	return trimmed && /^[0-9a-f]{7,40}$/iu.test(trimmed) ? trimmed.slice(0, 8) : null;
}

function formatBehindCount(count: number | null | undefined, source: "local" | "remote"): string {
	return count == null ? `${source} unavailable` : `${count} behind ${source}`;
}

export function resolveTaskBaseRefDisplayState(
	input: RuntimeTaskBaseRefInput & {
		behindBaseCount?: number | null | undefined;
		behindRemoteBaseCount?: number | null | undefined;
	},
): TaskBaseRefDisplayState {
	const baseRefState = resolveRuntimeTaskBaseRefState(input);
	if (!baseRefState.isResolved) {
		return {
			baseRefState,
			triggerLabel: "select base branch",
			behindLabel: null,
			isBehind: false,
			pinToggleLabel: null,
		};
	}

	return {
		baseRefState,
		triggerLabel: `from ${baseRefState.baseRef}`,
		behindLabel: `${formatBehindCount(input.behindBaseCount, "local")} · ${formatBehindCount(input.behindRemoteBaseCount, "remote")}`,
		isBehind: (input.behindBaseCount ?? 0) > 0 || (input.behindRemoteBaseCount ?? 0) > 0,
		pinToggleLabel: baseRefState.isPinned ? "Pinned - won't auto-update" : "Unpinned - auto-updates on branch change",
	};
}

export function resolveDetachedWorktreeDisplay({
	baseRef,
	headCommit,
}: DetachedWorktreeDisplayInput): DetachedWorktreeDisplayState | null {
	const baseRefState = resolveRuntimeTaskBaseRefState({ baseRef });
	if (!baseRefState.isResolved) {
		return null;
	}
	const normalizedHeadCommit = headCommit?.trim() || null;
	const shortCommit = formatShortCommit(normalizedHeadCommit);
	const commitPrefix = shortCommit ? `HEAD is at ${shortCommit}. ` : "";
	return {
		baseRef: baseRefState.baseRef,
		headCommit: normalizedHeadCommit,
		label: `detached from ${baseRefState.baseRef}`,
		tooltip: `${commitPrefix}This task has an independent detached worktree from ${baseRefState.baseRef}. Other tasks can show the same commit hash; changes here stay in this worktree.`,
	};
}

export function resolveDetachedTaskWorktreeDisplay({
	isDetached,
	isAssignedShared,
	baseRef,
	headCommit,
}: DetachedTaskWorktreeDisplayInput): DetachedWorktreeDisplayState | null {
	if (!isDetached || isAssignedShared) {
		return null;
	}
	return resolveDetachedWorktreeDisplay({ baseRef, headCommit });
}
