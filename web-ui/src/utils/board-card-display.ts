import type { RuntimeTaskSessionSummary } from "@/runtime/types";

export const CARD_TEXT_COLOR = {
	muted: "var(--color-text-tertiary)",
	secondary: "var(--color-text-secondary)",
} as const;

const TOOLTIP_MAX_LENGTH = 80;

export function shortenBranchName(branch: string): string {
	return branch.replace(/^(?:feature|fix|chore|hotfix|bugfix|release|refactor|feat)\//i, "") || branch;
}

export function getCardHoverTooltip(summary: RuntimeTaskSessionSummary | undefined): string | null {
	if (!summary) {
		return null;
	}
	if (summary.displaySummary) {
		return summary.displaySummary;
	}
	if (summary.conversationSummaries.length > 0) {
		const last = summary.conversationSummaries[summary.conversationSummaries.length - 1];
		const text = last?.text?.trim();
		if (text) {
			return text.length > TOOLTIP_MAX_LENGTH ? `${text.slice(0, TOOLTIP_MAX_LENGTH)}\u2026` : text;
		}
	}
	return null;
}
