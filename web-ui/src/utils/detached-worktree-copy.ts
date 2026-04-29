import { resolveDetachedWorktreeDisplay } from "@/utils/task-base-ref-display";

export interface DetachedWorktreeCopyInput {
	baseRef: string | null | undefined;
	headCommit?: string | null | undefined;
}

export function formatDetachedWorktreeLabel(baseRef: string | null | undefined): string | null {
	return resolveDetachedWorktreeDisplay({ baseRef })?.label ?? null;
}

export function getDetachedWorktreeTooltip({ baseRef, headCommit }: DetachedWorktreeCopyInput): string {
	return (
		resolveDetachedWorktreeDisplay({ baseRef, headCommit })?.tooltip ??
		"This task has an independent detached worktree from its base ref. Other tasks can show the same commit hash; changes here stay in this worktree."
	);
}
