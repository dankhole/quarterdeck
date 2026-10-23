export const CARD_TEXT_COLOR = {
	muted: "var(--color-text-tertiary)",
	secondary: "var(--color-text-secondary)",
} as const;

export function shortenBranchName(branch: string): string {
	return branch.replace(/^(?:feature|fix|chore|hotfix|bugfix|release|refactor|feat)\//i, "") || branch;
}
