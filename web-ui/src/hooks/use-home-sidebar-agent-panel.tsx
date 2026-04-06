// Composes the sidebar agent surface for the current workspace.
// It decides whether the synthetic home session should render a terminal panel
// and wires that surface to shared runtime actions.
import type { ReactElement } from "react";
import { useCallback, useMemo, useState } from "react";

import { AgentTerminalPanel } from "@/components/detail-panels/agent-terminal-panel";
import { Spinner } from "@/components/ui/spinner";
import { selectNewestTaskSessionSummary } from "@/hooks/home-sidebar-agent-panel-session-summary";
import { useHomeAgentSession } from "@/hooks/use-home-agent-session";
import type { RuntimeConfigResponse, RuntimeGitRepositoryInfo, RuntimeTaskSessionSummary } from "@/runtime/types";
import { TERMINAL_THEME_COLORS } from "@/terminal/theme-colors";

interface UseHomeSidebarAgentPanelInput {
	currentProjectId: string | null;
	hasNoProjects: boolean;
	runtimeProjectConfig: RuntimeConfigResponse | null;
	taskSessions: Record<string, RuntimeTaskSessionSummary>;
	workspaceGit: RuntimeGitRepositoryInfo | null;
}

export function useHomeSidebarAgentPanel({
	currentProjectId,
	hasNoProjects,
	runtimeProjectConfig,
	taskSessions,
	workspaceGit,
}: UseHomeSidebarAgentPanelInput): ReactElement | null {
	const [sessionSummaries, setSessionSummaries] = useState<Record<string, RuntimeTaskSessionSummary>>({});
	const upsertSessionSummary = useCallback((summary: RuntimeTaskSessionSummary) => {
		setSessionSummaries((currentSessions) => {
			const previousSummary = currentSessions[summary.taskId] ?? null;
			const newestSummary = selectNewestTaskSessionSummary(previousSummary, summary);
			if (newestSummary !== summary) {
				return currentSessions;
			}
			return {
				...currentSessions,
				[summary.taskId]: newestSummary,
			};
		});
	}, []);
	const effectiveSessionSummaries = useMemo(() => {
		const mergedSessionSummaries = { ...taskSessions };
		for (const [taskId, summary] of Object.entries(sessionSummaries)) {
			const newestSummary = selectNewestTaskSessionSummary(mergedSessionSummaries[taskId] ?? null, summary);
			if (newestSummary) {
				mergedSessionSummaries[taskId] = newestSummary;
			}
		}
		return mergedSessionSummaries;
	}, [sessionSummaries, taskSessions]);
	const { panelMode, taskId } = useHomeAgentSession({
		currentProjectId,
		runtimeProjectConfig,
		workspaceGit,
		sessionSummaries: effectiveSessionSummaries,
		setSessionSummaries,
		upsertSessionSummary,
	});

	const selectedAgentLabel = useMemo(() => {
		if (!runtimeProjectConfig) {
			return "selected agent";
		}
		return (
			runtimeProjectConfig.agents.find((agent) => agent.id === runtimeProjectConfig.selectedAgentId)?.label ??
			"selected agent"
		);
	}, [runtimeProjectConfig]);

	const homeAgentPanelSummary = taskId ? (effectiveSessionSummaries[taskId] ?? null) : null;

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
				panelBackgroundColor={TERMINAL_THEME_COLORS.surfaceRaised}
				terminalBackgroundColor={TERMINAL_THEME_COLORS.surfaceRaised}
				cursorColor={TERMINAL_THEME_COLORS.textPrimary}
			/>
		);
	}

	return (
		<div className="flex w-full items-center justify-center rounded-md border border-border bg-surface-2 px-3 text-center text-sm text-text-secondary">
			No runnable {selectedAgentLabel} command is configured. Open Settings, install the CLI, and select it.
		</div>
	);
}
