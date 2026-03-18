import type { ReactElement } from "react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { AgentTerminalPanel } from "@/components/detail-panels/agent-terminal-panel";
import { ClineAgentChatPanel } from "@/components/detail-panels/cline-agent-chat-panel";
import { Spinner } from "@/components/ui/spinner";
import { createIdleTaskSession } from "@/hooks/app-utils";
import { useHomeAgentSession } from "@/hooks/use-home-agent-session";
import { getRuntimeTrpcClient } from "@/runtime/trpc-client";
import type {
	RuntimeConfigResponse,
	RuntimeGitRepositoryInfo,
	RuntimeStateStreamTaskChatMessage,
	RuntimeTaskChatMessage,
	RuntimeTaskSessionSummary,
} from "@/runtime/types";
import { TERMINAL_THEME_COLORS } from "@/terminal/theme-colors";

interface TaskChatActionResult {
	ok: boolean;
	message?: string;
}

interface UseHomeSidebarAgentPanelInput {
	currentProjectId: string | null;
	hasNoProjects: boolean;
	runtimeProjectConfig: RuntimeConfigResponse | null;
	workspaceGit: RuntimeGitRepositoryInfo | null;
	latestTaskChatMessage: RuntimeStateStreamTaskChatMessage | null;
}

function toErrorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

async function stopHomeSidebarTaskSession(workspaceId: string, taskId: string): Promise<void> {
	try {
		await getRuntimeTrpcClient(workspaceId).runtime.stopTaskSession.mutate({
			taskId,
		});
	} catch {
		// Ignore stop errors during stale-session cleanup.
	}
}

export function useHomeSidebarAgentPanel({
	currentProjectId,
	hasNoProjects,
	runtimeProjectConfig,
	workspaceGit,
	latestTaskChatMessage,
}: UseHomeSidebarAgentPanelInput): ReactElement | null {
	const [sessionSummaries, setSessionSummaries] = useState<Record<string, RuntimeTaskSessionSummary>>({});
	const upsertSessionSummary = useCallback((summary: RuntimeTaskSessionSummary) => {
		setSessionSummaries((currentSessions) => ({
			...currentSessions,
			[summary.taskId]: summary,
		}));
	}, []);
	const { panelMode, taskId } = useHomeAgentSession({
		currentProjectId,
		runtimeProjectConfig,
		workspaceGit,
		sessionSummaries,
		setSessionSummaries,
		upsertSessionSummary,
	});
	const currentTaskIdRef = useRef<string | null>(null);

	useEffect(() => {
		currentTaskIdRef.current = taskId;
	}, [taskId]);

	const selectedAgentLabel = useMemo(() => {
		if (!runtimeProjectConfig) {
			return "selected agent";
		}
		return (
			runtimeProjectConfig.agents.find((agent) => agent.id === runtimeProjectConfig.selectedAgentId)?.label ??
			"selected agent"
		);
	}, [runtimeProjectConfig]);

	const homeAgentPanelSummary = taskId ? (sessionSummaries[taskId] ?? null) : null;
	const latestHomeTaskChatMessage = useMemo(() => {
		if (!taskId || !latestTaskChatMessage || latestTaskChatMessage.taskId !== taskId) {
			return null;
		}
		return latestTaskChatMessage.message;
	}, [latestTaskChatMessage, taskId]);

	const handleSendHomeClineChatMessage = useCallback(
		async (messageTaskId: string, text: string): Promise<TaskChatActionResult> => {
			if (!currentProjectId) {
				return { ok: false, message: "No project selected." };
			}
			try {
				const payload = await getRuntimeTrpcClient(currentProjectId).runtime.sendTaskChatMessage.mutate({
					taskId: messageTaskId,
					text,
				});
				if (!payload.ok) {
					return { ok: false, message: payload.error ?? "Task chat message failed." };
				}
				if (payload.summary) {
					upsertSessionSummary(payload.summary);
				}
				if (currentTaskIdRef.current !== messageTaskId) {
					await stopHomeSidebarTaskSession(currentProjectId, messageTaskId);
				}
				return { ok: true };
			} catch (error) {
				return { ok: false, message: toErrorMessage(error) };
			}
		},
		[currentProjectId, upsertSessionSummary],
	);

	const handleLoadHomeClineChatMessages = useCallback(
		async (messageTaskId: string): Promise<RuntimeTaskChatMessage[] | null> => {
			if (!currentProjectId) {
				return null;
			}
			try {
				const payload = await getRuntimeTrpcClient(currentProjectId).runtime.getTaskChatMessages.query({
					taskId: messageTaskId,
				});
				return payload.ok ? payload.messages : null;
			} catch {
				return null;
			}
		},
		[currentProjectId],
	);

	const handleCancelHomeClineChatTurn = useCallback(
		async (messageTaskId: string): Promise<TaskChatActionResult> => {
			if (!currentProjectId) {
				return { ok: false, message: "No project selected." };
			}
			try {
				const payload = await getRuntimeTrpcClient(currentProjectId).runtime.cancelTaskChatTurn.mutate({
					taskId: messageTaskId,
				});
				if (!payload.ok) {
					return { ok: false, message: payload.error ?? "Could not cancel chat turn." };
				}
				if (payload.summary) {
					upsertSessionSummary(payload.summary);
				}
				return { ok: true };
			} catch (error) {
				return { ok: false, message: toErrorMessage(error) };
			}
		},
		[currentProjectId, upsertSessionSummary],
	);

	if (hasNoProjects || !currentProjectId) {
		return null;
	}

	if (!runtimeProjectConfig) {
		return (
			<div className="flex w-full items-center justify-center rounded-md border border-border bg-surface-2 px-3 py-6">
				<Spinner size={20} />
			</div>
		);
	}

	if (panelMode === "chat" && taskId) {
		return (
			<ClineAgentChatPanel
				key={taskId}
				taskId={taskId}
				summary={homeAgentPanelSummary ?? createIdleTaskSession(taskId)}
				onSendMessage={handleSendHomeClineChatMessage}
				onCancelTurn={handleCancelHomeClineChatTurn}
				onLoadMessages={handleLoadHomeClineChatMessages}
				incomingMessage={latestHomeTaskChatMessage}
				showRightBorder={false}
				composerPlaceholder="Ask Cline anything about this repository"
			/>
		);
	}

	if (panelMode === "terminal" && taskId) {
		return (
			<AgentTerminalPanel
				key={taskId}
				taskId={taskId}
				workspaceId={currentProjectId}
				summary={homeAgentPanelSummary}
				onSummary={upsertSessionSummary}
				showSessionToolbar={false}
				autoFocus
				panelBackgroundColor={TERMINAL_THEME_COLORS.surfacePrimary}
				terminalBackgroundColor={TERMINAL_THEME_COLORS.surfacePrimary}
				cursorColor={TERMINAL_THEME_COLORS.textPrimary}
				showRightBorder={false}
			/>
		);
	}

	if (runtimeProjectConfig.selectedAgentId !== "cline") {
		return (
			<div className="flex w-full items-center justify-center rounded-md border border-border bg-surface-2 px-3 text-center text-sm text-text-secondary">
				No runnable {selectedAgentLabel} command is configured. Open Settings, install the CLI, and select it.
			</div>
		);
	}

	return (
		<div className="flex w-full items-center justify-center rounded-md border border-border bg-surface-2 px-3 text-center text-sm text-text-secondary">
			Select a Cline provider in Settings to start a home chat session.
		</div>
	);
}
