import { useCallback, useEffect, useRef, useState } from "react";
import { notifyError } from "@/components/app-toaster";
import { usePreferenceStorageEffect } from "@/hooks/settings/use-preference-storage-effect";
import {
	type ShellTerminalIntent,
	ShellTerminalOperations,
	type ShellTerminalScope,
} from "@/hooks/terminal/shell-terminal-operations";
import {
	computeTerminalPaneHeight,
	loadBottomTerminalPaneHeight,
	persistBottomTerminalPaneHeight as persistPaneHeight,
	resolveShellTerminalGeometry,
} from "@/hooks/terminal/terminal-panels";
import { useShellAutoRestart } from "@/hooks/terminal/use-shell-auto-restart";
import { getRuntimeTrpcClient } from "@/runtime/trpc-client";
import type { RuntimeGitRepositoryInfo, RuntimeTaskSessionSummary } from "@/runtime/types";
import { LocalStorageKey, removeLocalStorageItem } from "@/storage/local-storage-store";
import { getDetailTerminalTaskId, HOME_TERMINAL_TASK_ID } from "@/terminal/terminal-constants";
import {
	getTerminalControllerAttachment,
	type TerminalControllerAttachment,
	waitForTerminalController,
} from "@/terminal/terminal-controller-registry";
import type { SendTerminalInputOptions } from "@/terminal/terminal-input";
import { disposeDedicatedTerminal, writeToTerminalBuffer } from "@/terminal/terminal-pool";
import type { BoardCard, CardSelection } from "@/types";
import { createClientLogger } from "@/utils/client-logger";
import { toErrorMessage } from "@/utils/to-error-message";

export {
	DETAIL_TERMINAL_TASK_PREFIX,
	getDetailTerminalTaskId,
	HOME_TERMINAL_TASK_ID,
} from "@/terminal/terminal-constants";

const log = createClientLogger("terminal-panels");

interface UseTerminalPanelsInput {
	currentProjectId: string | null;
	selectedCard: CardSelection | null;
	projectGit: RuntimeGitRepositoryInfo | null;
	configDefaultBaseRef: string;
	agentCommand: string | null;
	shellAutoRestartEnabled: boolean;
	sessions: Record<string, RuntimeTaskSessionSummary>;
	findCard: (cardId: string) => BoardCard | null;
	upsertSession: (projectId: string, summary: RuntimeTaskSessionSummary) => void;
	sendTaskSessionInput: (
		taskId: string,
		text: string,
		options: SendTerminalInputOptions,
	) => Promise<{ ok: boolean; message?: string }>;
}

interface PrepareTerminalForShortcutResult {
	hadExistingSession?: boolean;
	ok: boolean;
	targetTaskId?: string;
	targetSessionInstanceId?: string;
	isCurrent?: () => boolean;
	message?: string;
}

export interface UseTerminalPanelsResult {
	homeTerminalTaskId: string;
	isHomeTerminalOpen: boolean;
	isHomeTerminalStarting: boolean;
	homeTerminalShellBinary: string | null;
	homeTerminalPaneHeight: number | undefined;
	isDetailTerminalOpen: boolean;
	detailTerminalTaskId: string | null;
	isDetailTerminalStarting: boolean;
	detailTerminalPaneHeight: number | undefined;
	isHomeTerminalExpanded: boolean;
	isDetailTerminalExpanded: boolean;
	setHomeTerminalPaneHeight: (height: number | undefined) => void;
	setDetailTerminalPaneHeight: (height: number | undefined) => void;
	handleToggleExpandHomeTerminal: () => void;
	handleToggleExpandDetailTerminal: () => void;
	handleToggleHomeTerminal: () => void;
	handleToggleDetailTerminal: () => void;
	handleSendAgentCommandToHomeTerminal: () => void;
	handleSendAgentCommandToDetailTerminal: () => void;
	handleRestartHomeTerminal: () => void;
	handleRestartDetailTerminal: () => void;
	prepareTerminalForShortcut: () => Promise<PrepareTerminalForShortcutResult>;
	resetBottomTerminalLayoutCustomizations: () => void;
	collapseHomeTerminal: () => void;
	collapseDetailTerminal: () => void;
	closeHomeTerminal: () => void;
	closeDetailTerminal: () => void;
	terminateHomeTerminal: () => void;
	terminateDetailTerminal: () => void;
	resetTerminalPanelsState: () => void;
	handleShellExit: (taskId: string, exitCode: number | null) => void;
	cancelPendingRestart: (taskId: string) => void;
}

interface PanelView {
	contextVersion: number;
	revision: number;
	homeOpen: boolean;
	detailOpen: boolean;
	homeExpanded: boolean;
	detailExpanded: boolean;
	homeShellBinary: string | null;
	startingTaskId: string | null;
}

function emptyPanelView(contextVersion: number, revision = 0): PanelView {
	return {
		contextVersion,
		revision,
		homeOpen: false,
		detailOpen: false,
		homeExpanded: false,
		detailExpanded: false,
		homeShellBinary: null,
		startingTaskId: null,
	};
}

interface ShellTarget extends ShellTerminalScope {
	baseRef: string;
	projectTaskId?: string;
}

interface ShellStartResult {
	summary: RuntimeTaskSessionSummary;
	hadExistingSession: boolean;
	intent: ShellTerminalIntent;
}

export function useTerminalPanels({
	currentProjectId,
	selectedCard,
	projectGit,
	configDefaultBaseRef,
	agentCommand,
	shellAutoRestartEnabled,
	sessions,
	findCard,
	upsertSession,
	sendTaskSessionInput,
}: UseTerminalPanelsInput): UseTerminalPanelsResult {
	const detailTerminalTaskId = selectedCard ? getDetailTerminalTaskId(selectedCard.card.id) : null;
	const contextRef = useRef({ projectId: currentProjectId, taskId: detailTerminalTaskId, version: 0 });
	if (contextRef.current.projectId !== currentProjectId || contextRef.current.taskId !== detailTerminalTaskId) {
		contextRef.current = {
			projectId: currentProjectId,
			taskId: detailTerminalTaskId,
			version: contextRef.current.version + 1,
		};
	}
	const contextVersion = contextRef.current.version;
	const [storedView, setStoredView] = useState(() => emptyPanelView(contextVersion));
	const viewRef = useRef(storedView);
	if (viewRef.current.contextVersion !== contextVersion) {
		viewRef.current = emptyPanelView(contextVersion, viewRef.current.revision + 1);
	}
	const view = storedView.contextVersion === contextVersion ? storedView : viewRef.current;
	const operationsRef = useRef(new ShellTerminalOperations());
	const latestSessionsRef = useRef(sessions);
	latestSessionsRef.current = sessions;
	const autoRestartEnabledRef = useRef(shellAutoRestartEnabled);
	autoRestartEnabledRef.current = shellAutoRestartEnabled;
	const mountedRef = useRef(true);
	const cancelPendingRestartRef = useRef<((taskId: string) => void) | null>(null);
	const [lastBottomTerminalPaneHeight, setLastBottomTerminalPaneHeight] = useState<number | undefined>(
		loadBottomTerminalPaneHeight,
	);
	usePreferenceStorageEffect(LocalStorageKey.BottomTerminalPaneHeight, () =>
		setLastBottomTerminalPaneHeight(loadBottomTerminalPaneHeight()),
	);

	// Keep immediate intent state as well as render state: multiple actions in one turn must converge.
	const updateView = useCallback((update: (previous: PanelView) => PanelView) => {
		viewRef.current = update(viewRef.current);
		setStoredView(viewRef.current);
	}, []);

	const isVisible = useCallback((taskId: string): boolean => {
		const context = contextRef.current;
		return taskId === HOME_TERMINAL_TASK_ID
			? context.taskId === null && viewRef.current.homeOpen
			: context.taskId === taskId && viewRef.current.detailOpen;
	}, []);

	const isCurrentIntent = useCallback(
		(intent: ShellTerminalIntent, version: number, taskId: string): boolean =>
			mountedRef.current &&
			contextRef.current.version === version &&
			operationsRef.current.isCurrent(intent) &&
			isVisible(taskId),
		[isVisible],
	);

	// Navigation and browser unmount release only viewers. Runtime PTYs outlive browser attachment.
	useEffect(() => {
		const projectId = currentProjectId;
		const taskId = detailTerminalTaskId;
		return () => {
			if (!projectId) return;
			for (const shellTaskId of [HOME_TERMINAL_TASK_ID, ...(taskId ? [taskId] : [])]) {
				operationsRef.current.cancel({ projectId, taskId: shellTaskId });
				cancelPendingRestartRef.current?.(shellTaskId);
				disposeDedicatedTerminal(projectId, shellTaskId);
			}
		};
	}, [currentProjectId, detailTerminalTaskId]);

	useEffect(() => {
		mountedRef.current = true;
		return () => {
			mountedRef.current = false;
			operationsRef.current.cancelAll();
		};
	}, []);

	const hideTerminal = useCallback(
		(taskId: string) => {
			const projectId = contextRef.current.projectId;
			if (projectId) {
				operationsRef.current.cancel({ projectId, taskId });
				cancelPendingRestartRef.current?.(taskId);
				disposeDedicatedTerminal(projectId, taskId);
			}
			updateView((previous) => ({
				...previous,
				revision: previous.revision + 1,
				...(taskId === HOME_TERMINAL_TASK_ID
					? { homeOpen: false, homeExpanded: false, homeShellBinary: null }
					: { detailOpen: false, detailExpanded: false }),
				startingTaskId: previous.startingTaskId === taskId ? null : previous.startingTaskId,
			}));
		},
		[updateView],
	);
	const closeHomeTerminal = useCallback(() => hideTerminal(HOME_TERMINAL_TASK_ID), [hideTerminal]);
	const closeDetailTerminal = useCallback(() => {
		const taskId = contextRef.current.taskId;
		if (taskId) hideTerminal(taskId);
	}, [hideTerminal]);

	const homeTarget: ShellTarget | null = currentProjectId
		? {
				projectId: currentProjectId,
				taskId: HOME_TERMINAL_TASK_ID,
				baseRef: projectGit?.currentBranch ?? (configDefaultBaseRef || projectGit?.defaultBranch) ?? "HEAD",
			}
		: null;
	const detailTarget: ShellTarget | null =
		currentProjectId && selectedCard && detailTerminalTaskId
			? {
					projectId: currentProjectId,
					taskId: detailTerminalTaskId,
					projectTaskId: selectedCard.card.id,
					baseRef: selectedCard.card.baseRef,
				}
			: null;

	const stopShell = useCallback(async (target: ShellTerminalScope) => {
		log.info("stopping shell terminal", target);
		const payload = await getRuntimeTrpcClient(target.projectId).runtime.stopTaskSession.mutate({
			taskId: target.taskId,
			waitForExit: true,
		});
		if (
			!payload.ok ||
			payload.didExit !== true ||
			(payload.outcome !== "exited" && payload.outcome !== "not_running")
		) {
			throw new Error(payload.error ?? "Could not confirm that the terminal session stopped. Try again.");
		}
		return payload.summary;
	}, []);

	const startTerminal = useCallback(
		(
			target: ShellTarget,
			options: {
				restart?: boolean;
				expectedExitedSessionInstanceId?: string;
				recoveryAttachment?: TerminalControllerAttachment;
			} = {},
		): Promise<ShellStartResult | null> => {
			const context = contextRef.current;
			if (
				context.projectId !== target.projectId ||
				(target.taskId === HOME_TERMINAL_TASK_ID ? context.taskId !== null : context.taskId !== target.taskId)
			)
				return Promise.resolve(null);
			const version = context.version;
			const intent = operationsRef.current.begin(target);
			cancelPendingRestartRef.current?.(target.taskId);
			updateView((previous) => ({
				...previous,
				revision: previous.revision + 1,
				...(target.taskId === HOME_TERMINAL_TASK_ID ? { homeOpen: true } : { detailOpen: true }),
				startingTaskId: target.taskId,
			}));
			const isCurrentUiIntent = () => isCurrentIntent(intent, version, target.taskId);
			const isCurrent = () =>
				isCurrentUiIntent() &&
				(!options.recoveryAttachment ||
					(autoRestartEnabledRef.current &&
						!options.recoveryAttachment.signal.aborted &&
						getTerminalControllerAttachment(target.taskId, {
							projectId: target.projectId,
							sessionInstanceId: options.expectedExitedSessionInstanceId,
						}) === options.recoveryAttachment));
			return operationsRef.current
				.run(target, async () => {
					if (!isCurrent()) return null;
					if (options.restart) {
						const summary = await stopShell(target);
						if (!isCurrent()) return null;
						if (summary) upsertSession(target.projectId, summary);
					}
					const geometry = await resolveShellTerminalGeometry(target.taskId);
					if (!isCurrent()) return null;
					log.info("starting or reattaching shell terminal", target);
					const payload = await getRuntimeTrpcClient(target.projectId).runtime.startShellSession.mutate({
						taskId: target.taskId,
						cols: geometry.cols,
						rows: geometry.rows,
						baseRef: target.baseRef,
						...(target.projectTaskId ? { projectTaskId: target.projectTaskId } : {}),
						...(options.expectedExitedSessionInstanceId
							? { expectedExitedSessionInstanceId: options.expectedExitedSessionInstanceId }
							: {}),
					});
					if (!isCurrent()) return null;
					if (!payload.ok || !payload.summary) {
						throw new Error(payload.error ?? "Could not start terminal session.");
					}
					latestSessionsRef.current = { ...latestSessionsRef.current, [target.taskId]: payload.summary };
					upsertSession(target.projectId, payload.summary);
					if (target.taskId === HOME_TERMINAL_TASK_ID) {
						updateView((previous) => ({
							...previous,
							homeShellBinary:
								typeof payload.shellBinary === "string" && payload.shellBinary.trim()
									? payload.shellBinary
									: null,
						}));
					}
					return { summary: payload.summary, hadExistingSession: payload.hadExistingSession, intent };
				})
				.catch((error: unknown) => {
					if (isCurrent()) notifyError(toErrorMessage(error));
					return null;
				})
				.finally(() => {
					if (isCurrentUiIntent()) updateView((previous) => ({ ...previous, startingTaskId: null }));
				});
		},
		[isCurrentIntent, stopShell, updateView, upsertSession],
	);

	const handleToggleHomeTerminal = useCallback(() => {
		if (viewRef.current.homeOpen) closeHomeTerminal();
		else if (homeTarget) void startTerminal(homeTarget);
	}, [closeHomeTerminal, homeTarget, startTerminal]);
	const handleToggleDetailTerminal = useCallback(() => {
		if (viewRef.current.detailOpen) closeDetailTerminal();
		else if (detailTarget) void startTerminal(detailTarget);
	}, [closeDetailTerminal, detailTarget, startTerminal]);

	const terminateTerminal = useCallback(
		(target: ShellTarget | null) => {
			if (!target) return;
			const version = contextRef.current.version;
			hideTerminal(target.taskId);
			// Even if navigation follows, explicit termination must finish for its original project/task.
			void operationsRef.current
				.run(target, () => stopShell(target))
				.then((summary) => {
					if (summary && mountedRef.current && contextRef.current.version === version) {
						upsertSession(target.projectId, summary);
					}
				})
				.catch((error: unknown) => notifyError(toErrorMessage(error)));
		},
		[hideTerminal, stopShell, upsertSession],
	);
	const terminateHomeTerminal = useCallback(() => terminateTerminal(homeTarget), [homeTarget, terminateTerminal]);
	const terminateDetailTerminal = useCallback(
		() => terminateTerminal(detailTarget),
		[detailTarget, terminateTerminal],
	);
	const handleRestartHomeTerminal = useCallback(() => {
		if (homeTarget && isVisible(homeTarget.taskId)) void startTerminal(homeTarget, { restart: true });
	}, [homeTarget, isVisible, startTerminal]);
	const handleRestartDetailTerminal = useCallback(() => {
		if (detailTarget && isVisible(detailTarget.taskId)) void startTerminal(detailTarget, { restart: true });
	}, [detailTarget, isVisible, startTerminal]);

	const { handleShellExit, cancelPendingRestart } = useShellAutoRestart({
		projectId: currentProjectId,
		shellAutoRestartEnabled,
		scopeKey: JSON.stringify([currentProjectId, detailTerminalTaskId, contextVersion, view.revision]),
		restartHomeTerminal: (expectedExitedSessionInstanceId, recoveryAttachment) =>
			homeTarget && isVisible(homeTarget.taskId)
				? startTerminal(homeTarget, { expectedExitedSessionInstanceId, recoveryAttachment }).then(
						(result) => result !== null,
					)
				: Promise.resolve(false),
		restartDetailTerminal: (cardId, expectedExitedSessionInstanceId, recoveryAttachment) =>
			detailTarget &&
			findCard(cardId) &&
			detailTerminalTaskId === getDetailTerminalTaskId(cardId) &&
			isVisible(detailTarget.taskId)
				? startTerminal(detailTarget, { expectedExitedSessionInstanceId, recoveryAttachment }).then(
						(result) => result !== null,
					)
				: Promise.resolve(false),
		writeToTerminal: (taskId, message) => {
			if (currentProjectId) writeToTerminalBuffer(currentProjectId, taskId, message);
		},
		getTerminalAttachment: (taskId, sessionInstanceId) =>
			currentProjectId !== null && isVisible(taskId)
				? getTerminalControllerAttachment(taskId, { projectId: currentProjectId, sessionInstanceId })
				: null,
		getSessionSummary: (taskId) => sessions[taskId] ?? null,
	});
	cancelPendingRestartRef.current = cancelPendingRestart;

	const prepareTerminalForShortcut = useCallback(async () => {
		const target = selectedCard ? detailTarget : homeTarget;
		if (!target) return { ok: false, message: "Select a project first." };
		const version = contextRef.current.version;
		const viewerWasOpen = isVisible(target.taskId);
		const existingSummary = latestSessionsRef.current[target.taskId];
		const shouldStart =
			!viewerWasOpen || viewRef.current.startingTaskId === target.taskId || existingSummary?.pid == null;
		const started =
			shouldStart || !existingSummary
				? startTerminal(target)
				: Promise.resolve({
						summary: existingSummary,
						hadExistingSession: true,
						intent: operationsRef.current.begin(target),
					});
		const revision = viewRef.current.revision;
		const stillCurrent = () =>
			mountedRef.current &&
			contextRef.current.version === version &&
			viewRef.current.revision === revision &&
			isVisible(target.taskId);
		const startResult = await started;
		if (!startResult || !stillCurrent()) {
			return { ok: false, message: "Terminal preparation was cancelled." };
		}
		const targetSessionInstanceId = startResult.summary.sessionInstanceId;
		if (!targetSessionInstanceId) return { ok: false, message: "Terminal scope is unavailable." };
		if (startResult.summary.pid === null) return { ok: false, message: "Terminal session is not running." };
		const targetSessionStartedAt = startResult.summary.startedAt ?? null;
		const isCurrentSession = () =>
			stillCurrent() &&
			operationsRef.current.isCurrent(startResult.intent) &&
			latestSessionsRef.current[target.taskId]?.sessionInstanceId === targetSessionInstanceId &&
			(latestSessionsRef.current[target.taskId]?.startedAt ?? null) === targetSessionStartedAt &&
			latestSessionsRef.current[target.taskId]?.pid != null;
		const scope = {
			projectId: target.projectId,
			sessionInstanceId: targetSessionInstanceId,
			sessionStartedAt: targetSessionStartedAt,
		};
		const attachment = await waitForTerminalController(target.taskId, scope, {
			signal: startResult.intent.signal,
			isCurrent: isCurrentSession,
		});
		if (!isCurrentSession()) return { ok: false, message: "Terminal preparation was cancelled." };
		if (!attachment?.ready || attachment.signal.aborted) return { ok: false, message: "Terminal is not connected." };
		return {
			hadExistingSession: startResult.hadExistingSession,
			ok: true,
			targetTaskId: target.taskId,
			targetSessionInstanceId,
			isCurrent: () =>
				isCurrentSession() &&
				attachment.ready &&
				!attachment.signal.aborted &&
				getTerminalControllerAttachment(target.taskId, scope) === attachment,
		};
	}, [detailTarget, homeTarget, isVisible, selectedCard, startTerminal]);

	const persistBottomTerminalPaneHeight = useCallback((height: number | undefined) => {
		if (typeof height === "number" && Number.isFinite(height)) {
			setLastBottomTerminalPaneHeight(persistPaneHeight(height));
		}
	}, []);
	const resetBottomTerminalPaneHeight = useCallback(() => {
		setLastBottomTerminalPaneHeight(undefined);
		removeLocalStorageItem(LocalStorageKey.BottomTerminalPaneHeight);
	}, []);
	const resetBottomTerminalLayoutCustomizations = useCallback(() => {
		resetBottomTerminalPaneHeight();
		updateView((previous) => ({ ...previous, homeExpanded: false, detailExpanded: false }));
	}, [resetBottomTerminalPaneHeight, updateView]);
	const collapseHomeTerminal = useCallback(() => {
		resetBottomTerminalPaneHeight();
		closeHomeTerminal();
	}, [closeHomeTerminal, resetBottomTerminalPaneHeight]);
	const collapseDetailTerminal = useCallback(() => {
		resetBottomTerminalPaneHeight();
		closeDetailTerminal();
	}, [closeDetailTerminal, resetBottomTerminalPaneHeight]);
	const setHomeTerminalPaneHeight = useCallback(
		(height: number | undefined) => {
			if (!viewRef.current.homeExpanded) persistBottomTerminalPaneHeight(height);
		},
		[persistBottomTerminalPaneHeight],
	);
	const setDetailTerminalPaneHeight = useCallback(
		(height: number | undefined) => {
			if (!viewRef.current.detailExpanded) persistBottomTerminalPaneHeight(height);
		},
		[persistBottomTerminalPaneHeight],
	);
	const handleToggleExpandHomeTerminal = useCallback(() => {
		updateView((previous) => ({ ...previous, homeExpanded: !previous.homeExpanded }));
	}, [updateView]);
	const handleToggleExpandDetailTerminal = useCallback(() => {
		if (contextRef.current.taskId) {
			updateView((previous) => ({ ...previous, detailExpanded: !previous.detailExpanded }));
		}
	}, [updateView]);
	const resetTerminalPanelsState = useCallback(() => {
		closeHomeTerminal();
		closeDetailTerminal();
		updateView((previous) => emptyPanelView(contextRef.current.version, previous.revision + 1));
	}, [closeDetailTerminal, closeHomeTerminal, updateView]);
	const handleSendAgentCommandToHomeTerminal = useCallback(() => {
		if (agentCommand) {
			void sendTaskSessionInput(HOME_TERMINAL_TASK_ID, agentCommand, { intent: "submit", appendNewline: true });
		}
	}, [agentCommand, sendTaskSessionInput]);
	const handleSendAgentCommandToDetailTerminal = useCallback(() => {
		if (agentCommand && detailTerminalTaskId) {
			void sendTaskSessionInput(detailTerminalTaskId, agentCommand, { intent: "submit", appendNewline: true });
		}
	}, [agentCommand, detailTerminalTaskId, sendTaskSessionInput]);

	return {
		homeTerminalTaskId: HOME_TERMINAL_TASK_ID,
		isHomeTerminalOpen: view.homeOpen,
		isHomeTerminalStarting: view.startingTaskId === HOME_TERMINAL_TASK_ID,
		homeTerminalShellBinary: view.homeShellBinary,
		homeTerminalPaneHeight: computeTerminalPaneHeight(view.homeExpanded, lastBottomTerminalPaneHeight),
		isDetailTerminalOpen: view.detailOpen,
		detailTerminalTaskId,
		isDetailTerminalStarting: detailTerminalTaskId !== null && view.startingTaskId === detailTerminalTaskId,
		detailTerminalPaneHeight: computeTerminalPaneHeight(view.detailExpanded, lastBottomTerminalPaneHeight),
		isHomeTerminalExpanded: view.homeExpanded,
		isDetailTerminalExpanded: view.detailExpanded,
		setHomeTerminalPaneHeight,
		setDetailTerminalPaneHeight,
		handleToggleExpandHomeTerminal,
		handleToggleExpandDetailTerminal,
		handleToggleHomeTerminal,
		handleToggleDetailTerminal,
		handleSendAgentCommandToHomeTerminal,
		handleSendAgentCommandToDetailTerminal,
		handleRestartHomeTerminal,
		handleRestartDetailTerminal,
		prepareTerminalForShortcut,
		resetBottomTerminalLayoutCustomizations,
		collapseHomeTerminal,
		collapseDetailTerminal,
		closeHomeTerminal,
		closeDetailTerminal,
		terminateHomeTerminal,
		terminateDetailTerminal,
		resetTerminalPanelsState,
		handleShellExit,
		cancelPendingRestart,
	};
}
