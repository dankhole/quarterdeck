import { useCallback, useEffect, useMemo, useState } from "react";

import { showAppToast } from "@/components/app-toaster";
import type { RuntimeAgentId } from "@/runtime/types";
import { LocalStorageKey } from "@/storage/local-storage-store";
import { findCardSelection } from "@/state/board-state";
import type { TaskStartSetupKind } from "@/telemetry/events";
import {
	toTelemetrySelectedAgentId,
	trackTaskStartSetupInstallCommandClicked,
	trackTaskStartSetupPromptViewed,
} from "@/telemetry/events";
import type { SendTerminalInputOptions } from "@/terminal/terminal-input";
import type { BoardData } from "@/types";
import { useBooleanLocalStorageValue } from "@/utils/react-use";

export interface TaskStartServicePromptContent {
	id: TaskStartSetupKind;
	title: string;
	description: string;
	learnMoreUrl?: string;
	installCommand?: string;
	installButtonLabel?: string;
	installCommandDescription?: string;
	authenticationNote?: string;
}

type TaskStartServicePromptPlatform = "mac" | "windows" | "other";

const LINEAR_WORD_PATTERN = /\blinear\b/i;
const GITHUB_WORD_PATTERN = /\bgithub\b/i;
const KANBAN_ACTION_WORDS = /\b(?:create|make|add|start|break|split|decompose|turn|convert)\b/i;
const KANBAN_NOUN_WORDS = /\b(?:tasks?|tickets?|cards?|projects?)\b/i;
const DEFAULT_LINEAR_INSTALL_COMMAND =
	"claude mcp add --transport http --scope user linear-server https://mcp.linear.app/mcp";
const DEFAULT_KANBAN_INSTALL_COMMAND = "claude mcp add --transport stdio --scope user kanban -- kanban mcp";

function getLinearMcpInstallCommand(selectedAgentId: RuntimeAgentId | null | undefined): string {
	switch (selectedAgentId) {
		case "codex":
			return "codex mcp add linear --url https://mcp.linear.app/mcp";
		case "gemini":
				return "gemini mcp add linear https://mcp.linear.app/mcp --transport http --scope user";
		case "opencode":
			return "opencode mcp add";
		case "droid":
			return "droid mcp add linear https://mcp.linear.app/mcp --type http";
		case "cline":
			return "droid mcp add linear https://mcp.linear.app/mcp --type http";
		default:
			return DEFAULT_LINEAR_INSTALL_COMMAND;
	}
}

function getKanbanMcpInstallCommand(selectedAgentId: RuntimeAgentId | null | undefined): string {
	switch (selectedAgentId) {
		case "codex":
			return "codex mcp add kanban -- kanban mcp";
		case "gemini":
				return "gemini mcp add kanban kanban mcp --scope user";
		case "opencode":
			return "opencode mcp add";
		case "droid":
			return "droid mcp add kanban -- kanban mcp";
		case "cline":
			return "droid mcp add kanban -- kanban mcp";
		default:
			return DEFAULT_KANBAN_INSTALL_COMMAND;
	}
}

function resolveTaskStartServicePromptPlatform(
	explicitPlatform?: TaskStartServicePromptPlatform,
): TaskStartServicePromptPlatform {
	if (explicitPlatform) {
		return explicitPlatform;
	}
	if (typeof navigator === "undefined") {
		return "other";
	}
	const platformSource = `${navigator.userAgent} ${navigator.platform}`.toLowerCase();
	if (platformSource.includes("mac") || platformSource.includes("darwin")) {
		return "mac";
	}
	if (platformSource.includes("win")) {
		return "windows";
	}
	return "other";
}

function getGithubCliInstallCommand(platform: TaskStartServicePromptPlatform): string | null {
	switch (platform) {
		case "mac":
			return "brew install gh";
		case "windows":
			return "winget install --id GitHub.cli";
		default:
			return null;
	}
}

export function getTaskStartServicePromptKey(taskId: string, promptId: TaskStartSetupKind): string {
	// Stable key used to remember a one-time dialog close for this specific task and prompt type.
	return `${taskId}:${promptId}`;
}

export function detectTaskStartServicePromptIds(prompt: string): TaskStartSetupKind[] {
	const normalizedPrompt = prompt.trim();
	if (!normalizedPrompt) {
		return [];
	}

	const results: TaskStartSetupKind[] = [];

	if (LINEAR_WORD_PATTERN.test(normalizedPrompt)) {
		results.push("linear_mcp");
	}

	if (GITHUB_WORD_PATTERN.test(normalizedPrompt)) {
		results.push("github_cli");
	}

	if (KANBAN_ACTION_WORDS.test(normalizedPrompt) && KANBAN_NOUN_WORDS.test(normalizedPrompt)) {
		results.push("kanban_mcp");
	}

	return results;
}

export function buildTaskStartServicePromptContent(
	promptId: TaskStartSetupKind,
	options?: { selectedAgentId?: RuntimeAgentId | null; platform?: TaskStartServicePromptPlatform },
): TaskStartServicePromptContent {
	switch (promptId) {
		case "linear_mcp": {
			const installCommand = getLinearMcpInstallCommand(options?.selectedAgentId ?? null);
			const isOpenCode = options?.selectedAgentId === "opencode";
			return {
				id: promptId,
				title: "Set up Linear MCP before starting this task?",
				description: isOpenCode
					? "This task looks like it references Linear. In OpenCode, run the command below, then use name: linear, server URL: https://mcp.linear.app/mcp, and complete OAuth authentication if prompted."
					: "This task looks like it references Linear. Connecting the Linear MCP gives the agent direct issue context while it works.",
				learnMoreUrl: "https://linear.app/docs/mcp",
				installCommand,
				installButtonLabel: "Run install command",
				installCommandDescription: isOpenCode
					? "Run this first, then follow OpenCode prompts:"
					: "Install command:",
				authenticationNote: isOpenCode
					? "After installing, run OpenCode and use /mcp to complete authentication."
					: "After installing, run your agent and use /mcp to complete authentication.",
			};
		}
		case "github_cli": {
			const platform = resolveTaskStartServicePromptPlatform(options?.platform);
			const installCommand = getGithubCliInstallCommand(platform);
			return {
				id: promptId,
				title: "Set up GitHub CLI before starting this task?",
				description:
					"This task includes a GitHub link. Setting up gh CLI helps the agent inspect issues and pull requests with native GitHub commands.",
				learnMoreUrl: "https://cli.github.com/",
				...(installCommand
					? {
							installCommand,
							installButtonLabel: "Run install command",
							installCommandDescription: "Install command:",
						}
					: {}),
			};
		}
		case "kanban_mcp": {
			const installCommand = getKanbanMcpInstallCommand(options?.selectedAgentId ?? null);
			const isOpenCode = options?.selectedAgentId === "opencode";
			return {
				id: promptId,
				title: "Set up Kanban MCP before starting this task?",
				description: isOpenCode
					? "This prompt looks like task-creation work. In OpenCode, run the command below, then use name: kanban, server type: Local MCP server, and command: kanban mcp."
					: "This prompt looks like task-creation work. Connecting the Kanban MCP helps the agent create and manage tasks directly.",
				learnMoreUrl: "https://github.com/cline/kanban",
				installCommand,
				installButtonLabel: "Run install command",
				installCommandDescription: isOpenCode
					? "Run this first, then follow OpenCode prompts:"
					: "Install command:",
			};
		}
		default:
			return {
				id: promptId,
				title: "Setup recommendation",
				description: "This task references an external service that can be configured for better context.",
			};
	}
}

interface PendingTaskStartServicePromptState {
	taskId: string;
	promptId: TaskStartSetupKind;
}

interface PrepareTerminalForShortcutResult {
	ok: boolean;
	targetTaskId?: string;
	message?: string;
}

interface UseTaskStartServicePromptsInput {
	board: BoardData;
	currentProjectId: string | null;
	selectedAgentId: RuntimeAgentId | null | undefined;
	handleCreateTask: () => string | null;
	handleStartTask: (taskId: string) => void;
	prepareTerminalForShortcut: (input: {
		prepareWaitForTerminalConnectionReady: (taskId: string) => () => Promise<void>;
	}) => Promise<PrepareTerminalForShortcutResult>;
	prepareWaitForTerminalConnectionReady: (taskId: string) => () => Promise<void>;
	sendTaskSessionInput: (
		taskId: string,
		text: string,
		options?: SendTerminalInputOptions,
	) => Promise<{ ok: boolean; message?: string }>;
}

export interface UseTaskStartServicePromptsResult {
	handleCreateAndStartTask: () => void;
	handleStartTaskWithServiceSetupPrompt: (taskId: string) => void;
	taskStartServicePromptDialogOpen: boolean;
	taskStartServicePromptDialogPrompt: TaskStartServicePromptContent | null;
	taskStartServicePromptDoNotShowAgain: boolean;
	setTaskStartServicePromptDoNotShowAgain: (value: boolean) => void;
	handleCloseTaskStartServicePrompt: () => void;
	handleRunTaskStartServiceInstallCommand: (() => void) | undefined;
}

export function useTaskStartServicePrompts({
	board,
	currentProjectId,
	selectedAgentId,
	handleCreateTask,
	handleStartTask,
	prepareTerminalForShortcut,
	prepareWaitForTerminalConnectionReady,
	sendTaskSessionInput,
}: UseTaskStartServicePromptsInput): UseTaskStartServicePromptsResult {
	const [isLinearTaskStartPromptDoNotShowAgain, setIsLinearTaskStartPromptDoNotShowAgain] =
		useBooleanLocalStorageValue(LocalStorageKey.TaskStartLinearSetupPromptDoNotShowAgain, false);
	const [isGithubTaskStartPromptDoNotShowAgain, setIsGithubTaskStartPromptDoNotShowAgain] =
		useBooleanLocalStorageValue(LocalStorageKey.TaskStartGithubSetupPromptDoNotShowAgain, false);
	const [isKanbanTaskStartPromptDoNotShowAgain, setIsKanbanTaskStartPromptDoNotShowAgain] =
		useBooleanLocalStorageValue(LocalStorageKey.TaskStartKanbanSetupPromptDoNotShowAgain, false);
	const [pendingTaskStartServicePromptQueue, setPendingTaskStartServicePromptQueue] = useState<
		PendingTaskStartServicePromptState[]
	>([]);
	const [pendingTaskStartAfterCreateId, setPendingTaskStartAfterCreateId] = useState<string | null>(null);
	const [taskStartServicePromptDoNotShowAgain, setTaskStartServicePromptDoNotShowAgain] = useState(false);
	const [taskStartServicePromptAcknowledgements, setTaskStartServicePromptAcknowledgements] = useState<
		Record<string, true>
	>({});

	useEffect(() => {
		setPendingTaskStartServicePromptQueue([]);
		setPendingTaskStartAfterCreateId(null);
		setTaskStartServicePromptDoNotShowAgain(false);
		setTaskStartServicePromptAcknowledgements({});
	}, [currentProjectId]);

	useEffect(() => {
		const activePendingPrompt = pendingTaskStartServicePromptQueue[0] ?? null;
		if (!activePendingPrompt) {
			return;
		}
		const selection = findCardSelection(board, activePendingPrompt.taskId);
		if (selection && selection.column.id === "backlog") {
			return;
		}
		setPendingTaskStartServicePromptQueue([]);
		setTaskStartServicePromptDoNotShowAgain(false);
	}, [board, pendingTaskStartServicePromptQueue]);

	const isTaskStartServicePromptDoNotShowAgainEnabled = useCallback(
		(promptId: TaskStartSetupKind): boolean => {
			switch (promptId) {
				case "linear_mcp":
					return isLinearTaskStartPromptDoNotShowAgain;
				case "github_cli":
					return isGithubTaskStartPromptDoNotShowAgain;
				case "kanban_mcp":
					return isKanbanTaskStartPromptDoNotShowAgain;
				default:
					return false;
			}
		},
		[
			isGithubTaskStartPromptDoNotShowAgain,
			isKanbanTaskStartPromptDoNotShowAgain,
			isLinearTaskStartPromptDoNotShowAgain,
		],
	);

	const setTaskStartServicePromptDoNotShowAgainPreference = useCallback(
		(promptId: TaskStartSetupKind, value: boolean) => {
			switch (promptId) {
				case "linear_mcp":
					setIsLinearTaskStartPromptDoNotShowAgain(value);
					return;
				case "github_cli":
					setIsGithubTaskStartPromptDoNotShowAgain(value);
					return;
				case "kanban_mcp":
					setIsKanbanTaskStartPromptDoNotShowAgain(value);
					return;
				default:
					return;
			}
		},
		[
			setIsGithubTaskStartPromptDoNotShowAgain,
			setIsKanbanTaskStartPromptDoNotShowAgain,
			setIsLinearTaskStartPromptDoNotShowAgain,
		],
	);

	const acknowledgeTaskStartServicePrompt = useCallback(
		(
			pendingPrompt: PendingTaskStartServicePromptState,
			options?: {
				suppressFuturePrompts?: boolean;
			},
		) => {
			setTaskStartServicePromptAcknowledgements((current) => ({
				...current,
				[getTaskStartServicePromptKey(pendingPrompt.taskId, pendingPrompt.promptId)]: true,
			}));
			if (options?.suppressFuturePrompts) {
				setTaskStartServicePromptDoNotShowAgainPreference(pendingPrompt.promptId, true);
			}
		},
		[setTaskStartServicePromptDoNotShowAgainPreference],
	);

	const runTaskStartServiceInstallCommand = useCallback(
		async (command: string): Promise<void> => {
			if (!currentProjectId) {
				showAppToast(
					{
						intent: "danger",
						icon: "warning-sign",
						message: "Could not run setup command because no project is selected.",
						timeout: 5000,
					},
					"task-start-service-setup-no-project",
				);
				return;
			}

			try {
				const prepared = await prepareTerminalForShortcut({
					prepareWaitForTerminalConnectionReady,
				});
				if (!prepared.ok || !prepared.targetTaskId) {
					throw new Error(prepared.message ?? "Could not open terminal.");
				}

				const sent = await sendTaskSessionInput(prepared.targetTaskId, command, {
					appendNewline: true,
				});
				if (!sent.ok) {
					throw new Error(sent.message ?? "Could not run setup command.");
				}
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				showAppToast(
					{
						intent: "danger",
						icon: "warning-sign",
						message: `Could not run setup command: ${message}`,
						timeout: 7000,
					},
					"task-start-service-setup-command-failed",
				);
			}
		},
		[currentProjectId, prepareTerminalForShortcut, prepareWaitForTerminalConnectionReady, sendTaskSessionInput],
	);

	const activePendingTaskStartServicePrompt = pendingTaskStartServicePromptQueue[0] ?? null;

	useEffect(() => {
		if (!activePendingTaskStartServicePrompt) {
			return;
		}
		trackTaskStartSetupPromptViewed({
			setup_kind: activePendingTaskStartServicePrompt.promptId,
			selected_agent_id: toTelemetrySelectedAgentId(selectedAgentId),
		});
	}, [activePendingTaskStartServicePrompt?.promptId, activePendingTaskStartServicePrompt?.taskId, selectedAgentId]);

	const taskStartServicePromptDialogPrompt = useMemo(() => {
		if (!activePendingTaskStartServicePrompt) {
			return null;
		}
		return buildTaskStartServicePromptContent(activePendingTaskStartServicePrompt.promptId, {
			selectedAgentId,
		});
	}, [activePendingTaskStartServicePrompt, selectedAgentId]);

	const handleCloseTaskStartServicePrompt = useCallback(() => {
		if (!activePendingTaskStartServicePrompt) {
			return;
		}

		acknowledgeTaskStartServicePrompt(activePendingTaskStartServicePrompt, {
			suppressFuturePrompts: taskStartServicePromptDoNotShowAgain,
		});
		setPendingTaskStartServicePromptQueue((currentQueue) => currentQueue.slice(1));
		setTaskStartServicePromptDoNotShowAgain(false);
	}, [
		acknowledgeTaskStartServicePrompt,
		activePendingTaskStartServicePrompt,
		taskStartServicePromptDoNotShowAgain,
	]);

	const handleRunTaskStartServiceInstallCommand = useCallback(() => {
		if (!activePendingTaskStartServicePrompt) {
			return;
		}

		const installCommand = taskStartServicePromptDialogPrompt?.installCommand?.trim();
		trackTaskStartSetupInstallCommandClicked({
			setup_kind: activePendingTaskStartServicePrompt.promptId,
			selected_agent_id: toTelemetrySelectedAgentId(selectedAgentId),
		});
		acknowledgeTaskStartServicePrompt(activePendingTaskStartServicePrompt, {
			suppressFuturePrompts: taskStartServicePromptDoNotShowAgain,
		});
		setPendingTaskStartServicePromptQueue((currentQueue) => currentQueue.slice(1));
		setTaskStartServicePromptDoNotShowAgain(false);
		if (!installCommand) {
			return;
		}
		void runTaskStartServiceInstallCommand(installCommand);
	}, [
		acknowledgeTaskStartServicePrompt,
		activePendingTaskStartServicePrompt,
		runTaskStartServiceInstallCommand,
		selectedAgentId,
		taskStartServicePromptDialogPrompt?.installCommand,
		taskStartServicePromptDoNotShowAgain,
	]);

	const handleStartTaskWithServiceSetupPrompt = useCallback(
		(taskId: string) => {
			const selection = findCardSelection(board, taskId);
			if (!selection || selection.column.id !== "backlog") {
				handleStartTask(taskId);
				return;
			}

			const detectedPromptIds = detectTaskStartServicePromptIds(selection.card.prompt);
			const queuedPrompts: PendingTaskStartServicePromptState[] = [];
			for (const promptId of detectedPromptIds) {
				if (isTaskStartServicePromptDoNotShowAgainEnabled(promptId)) {
					continue;
				}

				const promptKey = getTaskStartServicePromptKey(taskId, promptId);
				if (taskStartServicePromptAcknowledgements[promptKey]) {
					continue;
				}

				queuedPrompts.push({ taskId, promptId });
			}

			if (queuedPrompts.length > 0) {
				setTaskStartServicePromptDoNotShowAgain(false);
				setPendingTaskStartServicePromptQueue(queuedPrompts);
				return;
			}

			if (detectedPromptIds.length > 0) {
				setTaskStartServicePromptAcknowledgements((current) => {
					let next = current;
					for (const promptId of detectedPromptIds) {
						const promptKey = getTaskStartServicePromptKey(taskId, promptId);
						if (!next[promptKey]) {
							continue;
						}
						if (next === current) {
							next = { ...current };
						}
						delete next[promptKey];
					}
					return next;
				});
			}

			handleStartTask(taskId);
		},
		[
			board,
			handleStartTask,
			isTaskStartServicePromptDoNotShowAgainEnabled,
			taskStartServicePromptAcknowledgements,
		],
	);

	const handleCreateAndStartTask = useCallback(() => {
		const taskId = handleCreateTask();
		if (!taskId) {
			return;
		}
		setPendingTaskStartAfterCreateId(taskId);
	}, [handleCreateTask]);

	useEffect(() => {
		if (!pendingTaskStartAfterCreateId) {
			return;
		}
		const selection = findCardSelection(board, pendingTaskStartAfterCreateId);
		if (!selection || selection.column.id !== "backlog") {
			return;
		}
		handleStartTaskWithServiceSetupPrompt(pendingTaskStartAfterCreateId);
		setPendingTaskStartAfterCreateId(null);
	}, [board, handleStartTaskWithServiceSetupPrompt, pendingTaskStartAfterCreateId]);

	return {
		handleCreateAndStartTask,
		handleStartTaskWithServiceSetupPrompt,
		taskStartServicePromptDialogOpen: pendingTaskStartServicePromptQueue.length > 0,
		taskStartServicePromptDialogPrompt,
		taskStartServicePromptDoNotShowAgain,
		setTaskStartServicePromptDoNotShowAgain,
		handleCloseTaskStartServicePrompt,
		handleRunTaskStartServiceInstallCommand: taskStartServicePromptDialogPrompt?.installCommand
			? handleRunTaskStartServiceInstallCommand
			: undefined,
	};
}
