import type { RuntimeTaskSessionSummary } from "@/runtime/types";

export const CARD_TEXT_COLOR = {
	muted: "var(--color-text-tertiary)",
	secondary: "var(--color-text-secondary)",
} as const;

const TOOLTIP_MAX_LENGTH = 80;

export function shortenBranchName(branch: string): string {
	return branch.replace(/^(?:feature|fix|chore|hotfix|bugfix|release|refactor|feat)\//i, "") || branch;
}

function extractToolInputSummaryFromActivityText(activityText: string, toolName: string): string | null {
	const escapedToolName = toolName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
	const match = activityText.match(
		new RegExp(`^(?:Using|Completed|Failed|Calling)\\s+${escapedToolName}(?::\\s*(.+))?$`),
	);
	if (!match) {
		return null;
	}
	const rawSummary = match[1]?.trim() ?? "";
	if (!rawSummary) {
		return null;
	}
	if (activityText.startsWith("Failed ")) {
		const [operationSummary] = rawSummary.split(": ");
		return operationSummary?.trim() || null;
	}
	return rawSummary;
}

function parseToolCallFromActivityText(
	activityText: string,
): { toolName: string; toolInputSummary: string | null } | null {
	const match = activityText.match(/^(?:Using|Completed|Failed|Calling)\s+([^:()]+?)(?::\s*(.+))?$/);
	if (!match?.[1]) {
		return null;
	}
	const toolName = match[1].trim();
	if (!toolName) {
		return null;
	}
	const rawSummary = match[2]?.trim() ?? "";
	if (!rawSummary) {
		return { toolName, toolInputSummary: null };
	}
	if (activityText.startsWith("Failed ")) {
		const [operationSummary] = rawSummary.split(": ");
		return {
			toolName,
			toolInputSummary: operationSummary?.trim() || null,
		};
	}
	return {
		toolName,
		toolInputSummary: rawSummary,
	};
}

function resolveToolCallLabel(
	activityText: string | undefined,
	toolName: string | null,
	toolInputSummary: string | null,
): string | null {
	if (toolName) {
		const summary = toolInputSummary ?? extractToolInputSummaryFromActivityText(activityText ?? "", toolName);
		return summary ? `${toolName}(${summary})` : toolName;
	}
	if (!activityText) {
		return null;
	}
	const parsed = parseToolCallFromActivityText(activityText);
	if (!parsed) {
		return null;
	}
	return parsed.toolInputSummary ? `${parsed.toolName}(${parsed.toolInputSummary})` : parsed.toolName;
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

export function getRunningActivityLabel(summary: RuntimeTaskSessionSummary | undefined): string | null {
	if (!summary || summary.state !== "running") {
		return null;
	}
	const hookActivity = summary.latestHookActivity;
	if (!hookActivity) {
		return null;
	}
	const activityText = hookActivity.activityText?.trim();
	const toolName = hookActivity.toolName?.trim() ?? null;
	const toolInputSummary = hookActivity.toolInputSummary?.trim() ?? null;
	if (activityText) {
		const toolCallLabel = resolveToolCallLabel(activityText, toolName, toolInputSummary);
		if (toolCallLabel) {
			return toolCallLabel;
		}
		if (activityText === "Agent active" || activityText === "Working on task" || activityText.startsWith("Resumed")) {
			return null;
		}
		if (activityText.startsWith("Agent: ")) {
			return activityText.slice(7);
		}
		return activityText;
	}
	return null;
}
