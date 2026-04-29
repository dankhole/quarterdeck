export interface DetachedWorktreeCopyInput {
	baseRef: string | null | undefined;
	headCommit?: string | null | undefined;
}

function normalizeBaseRef(baseRef: string | null | undefined): string | null {
	const trimmed = baseRef?.trim();
	return trimmed ? trimmed : null;
}

function formatShortCommit(headCommit: string | null | undefined): string | null {
	const trimmed = headCommit?.trim();
	return trimmed && /^[0-9a-f]{7,40}$/iu.test(trimmed) ? trimmed.slice(0, 8) : null;
}

export function formatDetachedWorktreeLabel(baseRef: string | null | undefined): string | null {
	const normalizedBaseRef = normalizeBaseRef(baseRef);
	return normalizedBaseRef ? `detached from ${normalizedBaseRef}` : null;
}

export function getDetachedWorktreeTooltip({ baseRef, headCommit }: DetachedWorktreeCopyInput): string {
	const normalizedBaseRef = normalizeBaseRef(baseRef);
	const shortCommit = formatShortCommit(headCommit);
	const commitPrefix = shortCommit ? `HEAD is at ${shortCommit}. ` : "";
	const baseCopy = normalizedBaseRef ? `from ${normalizedBaseRef}` : "from its base ref";
	return `${commitPrefix}This task has an independent detached worktree ${baseCopy}. Other tasks can show the same commit hash; changes here stay in this worktree.`;
}
