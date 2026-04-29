import {
	createTaggedLogger,
	findCardInBoard,
	type IRuntimeConfigProvider,
	type RuntimeTaskSessionSummary,
} from "../core";
import { loadProjectState } from "../state";
import type { TerminalSessionManager } from "../terminal";
import {
	buildTaskGenerationContext,
	generateDisplaySummary,
	isLlmConfigured,
	SUMMARY_FIRST_ACTIVITY_LIMIT,
	SUMMARY_LATEST_ACTIVITY_LIMIT,
	SUMMARY_ORIGINAL_PROMPT_LIMIT,
	SUMMARY_PREVIOUS_ACTIVITY_LIMIT,
} from "../title";
import type { RuntimeTrpcProjectScope } from "./app-router-context";

const log = createTaggedLogger("summary-polish");
const polishGenerationInFlight = new Set<string>();

type BackgroundTaskScheduler = (task: () => void) => void;
type DisplaySummaryPolishRequest = {
	projectScope: RuntimeTrpcProjectScope;
	taskId: string;
	deps: DisplaySummaryPolishDeps;
	reason: string;
	promptOverride?: string | null;
};

const pendingPolishRequests = new Map<string, DisplaySummaryPolishRequest>();

export interface DisplaySummaryPolishDeps {
	config: Pick<IRuntimeConfigProvider, "loadScopedRuntimeConfig">;
	getScopedTerminalManager: (scope: RuntimeTrpcProjectScope) => Promise<TerminalSessionManager>;
	loadProjectState?: typeof loadProjectState;
	scheduleBackgroundTask?: BackgroundTaskScheduler;
	now?: () => number;
}

function defaultScheduleBackgroundTask(task: () => void): void {
	const timeout = setTimeout(task, 0);
	timeout.unref?.();
}

function latestConversationSummaryCapturedAt(summary: RuntimeTaskSessionSummary): number {
	return summary.conversationSummaries.reduce((latest, entry) => Math.max(latest, entry.capturedAt), 0);
}

function summarySourceUpdatedAt(summary: RuntimeTaskSessionSummary): number {
	const finalMessageAt = summary.latestHookActivity?.finalMessage ? (summary.lastHookAt ?? 0) : 0;
	return Math.max(latestConversationSummaryCapturedAt(summary), finalMessageAt);
}

function shouldPolishDisplaySummary(summary: RuntimeTaskSessionSummary): boolean {
	const generatedAt = summary.displaySummaryGeneratedAt ?? null;
	if (generatedAt === null) {
		return true;
	}

	const sourceUpdatedAt = summarySourceUpdatedAt(summary);
	return sourceUpdatedAt > 0 && sourceUpdatedAt > generatedAt;
}

function buildPolishSourceText(input: {
	prompt: string | null | undefined;
	summary: RuntimeTaskSessionSummary;
}): string | null {
	return buildTaskGenerationContext({
		prompt: input.prompt,
		summaries: input.summary.conversationSummaries,
		finalMessage: input.summary.latestHookActivity?.finalMessage,
		limits: {
			originalPrompt: SUMMARY_ORIGINAL_PROMPT_LIMIT,
			firstActivity: SUMMARY_FIRST_ACTIVITY_LIMIT,
			latestActivity: SUMMARY_LATEST_ACTIVITY_LIMIT,
			previousActivity: SUMMARY_PREVIOUS_ACTIVITY_LIMIT,
		},
	});
}

function buildPolishSourceFingerprint(input: {
	prompt: string | null | undefined;
	summary: RuntimeTaskSessionSummary;
}): string {
	return JSON.stringify({
		prompt: input.prompt?.replace(/\s+/g, " ").trim() ?? "",
		summaries: input.summary.conversationSummaries.map((entry) => ({
			sessionIndex: entry.sessionIndex,
			capturedAt: entry.capturedAt,
			text: entry.text,
		})),
		finalMessage: input.summary.latestHookActivity?.finalMessage ?? null,
		finalMessageAt: input.summary.latestHookActivity?.finalMessage ? (input.summary.lastHookAt ?? null) : null,
	});
}

function queuePendingPolishIfNeeded(inFlightKey: string): void {
	const pending = pendingPolishRequests.get(inFlightKey);
	if (!pending) {
		return;
	}
	pendingPolishRequests.delete(inFlightKey);
	queueTaskDisplaySummaryPolish(pending);
}

export async function polishTaskDisplaySummary(input: DisplaySummaryPolishRequest): Promise<string | null> {
	const runtimeConfig = await input.deps.config.loadScopedRuntimeConfig(input.projectScope);
	if (!runtimeConfig.llmSummaryPolishEnabled || !isLlmConfigured()) {
		return null;
	}

	const inFlightKey = `${input.projectScope.projectId}:${input.taskId}`;
	if (polishGenerationInFlight.has(inFlightKey)) {
		pendingPolishRequests.set(inFlightKey, input);
		return null;
	}

	const terminalManager = await input.deps.getScopedTerminalManager(input.projectScope);
	const session = terminalManager.store.getSummary(input.taskId);
	if (!session || !shouldPolishDisplaySummary(session)) {
		return null;
	}

	const loadState = input.deps.loadProjectState ?? loadProjectState;
	const projectState = await loadState(input.projectScope.projectPath);
	const card = findCardInBoard(projectState.board, input.taskId);
	const prompt = input.promptOverride ?? card?.prompt;
	const sourceText = buildPolishSourceText({
		prompt,
		summary: session,
	});
	if (!sourceText?.trim()) {
		return null;
	}
	const sourceFingerprint = buildPolishSourceFingerprint({ prompt, summary: session });

	polishGenerationInFlight.add(inFlightKey);
	try {
		log.debug("Polishing display summary", {
			projectId: input.projectScope.projectId,
			taskId: input.taskId,
			reason: input.reason,
			summaryCount: session.conversationSummaries.length,
			sourceTextSnippet: sourceText.slice(0, 120),
		});
		const generated = await generateDisplaySummary(sourceText);
		if (!generated) {
			return null;
		}
		const currentSession = terminalManager.store.getSummary(input.taskId);
		const currentFingerprint = currentSession
			? buildPolishSourceFingerprint({ prompt, summary: currentSession })
			: null;
		if (currentFingerprint !== sourceFingerprint) {
			log.debug("Discarded stale display summary polish result", {
				projectId: input.projectScope.projectId,
				taskId: input.taskId,
				reason: input.reason,
			});
			return null;
		}
		const generatedAt = (input.deps.now ?? Date.now)();
		terminalManager.store.setDisplaySummary(input.taskId, generated, generatedAt);
		return generated;
	} finally {
		polishGenerationInFlight.delete(inFlightKey);
		queuePendingPolishIfNeeded(inFlightKey);
	}
}

export function queueTaskDisplaySummaryPolish(input: DisplaySummaryPolishRequest): void {
	const schedule = input.deps.scheduleBackgroundTask ?? defaultScheduleBackgroundTask;
	schedule(() => {
		void polishTaskDisplaySummary(input).catch((error) => {
			log.warn("Display summary polish failed", {
				projectId: input.projectScope.projectId,
				taskId: input.taskId,
				reason: input.reason,
				error: error instanceof Error ? error.message : String(error),
			});
		});
	});
}
