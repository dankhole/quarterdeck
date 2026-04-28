import { useCallback, useEffect, useRef, useState } from "react";

import { notifyError } from "@/components/app-toaster";
import {
	collapseAllDetailPanels,
	computeTerminalPaneHeight,
	DEFAULT_DETAIL_TERMINAL_PANEL_STATE,
	type DetailTerminalPanelState,
	loadBottomTerminalPaneHeight,
	persistBottomTerminalPaneHeight as persistPaneHeight,
	resolveShellTerminalGeometry,
} from "@/hooks/terminal/terminal-panels";
import { useShellAutoRestart } from "@/hooks/terminal/use-shell-auto-restart";
import { getRuntimeTrpcClient } from "@/runtime/trpc-client";
import type { RuntimeGitRepositoryInfo, RuntimeTaskSessionSummary } from "@/runtime/types";
import { LocalStorageKey, removeLocalStorageItem } from "@/storage/local-storage-store";
import { getDetailTerminalTaskId, HOME_TERMINAL_TASK_ID } from "@/terminal/terminal-constants";
import { createClientLogger } from "@/utils/client-logger";

export {
	DETAIL_TERMINAL_TASK_PREFIX,
	getDetailTerminalTaskId,
	HOME_TERMINAL_TASK_ID,
} from "@/terminal/terminal-constants";

import type { SendTerminalInputOptions } from "@/terminal/terminal-input";
import { disposeDedicatedTerminal, isTerminalSessionRunning, writeToTerminalBuffer } from "@/terminal/terminal-pool";
import type { BoardCard, CardSelection } from "@/types";
import { toErrorMessage } from "@/utils/to-error-message";

const log = createClientLogger("terminal-panels");

function buildShellStopKey(projectId: string, taskId: string): string {
	return `${projectId}:${taskId}`;
}

interface StartDetailTerminalOptions {
	showLoading?: boolean;
}

interface UseTerminalPanelsInput {
	currentProjectId: string | null;
	selectedCard: CardSelection | null;
	projectGit: RuntimeGitRepositoryInfo | null;
	configDefaultBaseRef: string;
	agentCommand: string | null;
	shellAutoRestartEnabled: boolean;
	findCard: (cardId: string) => BoardCard | null;
	upsertSession: (summary: RuntimeTaskSessionSummary) => void;
	sendTaskSessionInput: (
		taskId: string,
		text: string,
		options?: SendTerminalInputOptions,
	) => Promise<{ ok: boolean; message?: string }>;
}

interface PrepareTerminalForShortcutInput {
	prepareWaitForTerminalConnectionReady: (taskId: string) => () => Promise<void>;
}

interface PrepareTerminalForShortcutResult {
	hadExistingOpenTerminal?: boolean;
	ok: boolean;
	targetTaskId?: string;
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
	prepareTerminalForShortcut: (input: PrepareTerminalForShortcutInput) => Promise<PrepareTerminalForShortcutResult>;
	resetBottomTerminalLayoutCustomizations: () => void;
	collapseHomeTerminal: () => void;
	collapseDetailTerminal: () => void;
	closeHomeTerminal: () => void;
	closeDetailTerminal: () => void;
	resetTerminalPanelsState: () => void;
	handleShellExit: (taskId: string, exitCode: number | null) => void;
	cancelPendingRestart: (taskId: string) => void;
}

export function useTerminalPanels({
	currentProjectId,
	selectedCard,
	projectGit,
	configDefaultBaseRef,
	agentCommand,
	shellAutoRestartEnabled,
	findCard,
	upsertSession,
	sendTaskSessionInput,
}: UseTerminalPanelsInput): UseTerminalPanelsResult {
	const homeTerminalProjectIdRef = useRef<string | null>(null);
	const detailTerminalSelectionKeyRef = useRef<string | null>(null);
	const previousDetailTerminalTaskIdRef = useRef<string | null>(null);
	const detailTerminalProjectIdByTaskIdRef = useRef<Record<string, string>>({});
	const cancelPendingRestartRef = useRef<((taskId: string) => void) | null>(null);
	const suppressNextShellExitRef = useRef<((taskId: string) => void) | null>(null);
	const clearSuppressedShellExitRef = useRef<((taskId: string) => void) | null>(null);
	const pendingShellStopsRef = useRef<Map<string, Promise<void>>>(new Map());
	const [isHomeTerminalOpen, setIsHomeTerminalOpen] = useState(false);
	const [isHomeTerminalStarting, setIsHomeTerminalStarting] = useState(false);
	const [homeTerminalShellBinary, setHomeTerminalShellBinary] = useState<string | null>(null);
	const [lastBottomTerminalPaneHeight, setLastBottomTerminalPaneHeight] = useState<number | undefined>(
		loadBottomTerminalPaneHeight,
	);
	const [detailTerminalPanelStateByTaskId, setDetailTerminalPanelStateByTaskId] = useState<
		Record<string, DetailTerminalPanelState>
	>({});
	const detailTerminalPanelStateByTaskIdRef = useRef(detailTerminalPanelStateByTaskId);
	const [isDetailTerminalStarting, setIsDetailTerminalStarting] = useState(false);
	const [isHomeTerminalExpanded, setIsHomeTerminalExpanded] = useState(false);
	const detailTerminalTaskId = selectedCard ? getDetailTerminalTaskId(selectedCard.card.id) : null;
	const currentDetailTerminalPanelState = detailTerminalTaskId
		? (detailTerminalPanelStateByTaskId[detailTerminalTaskId] ?? DEFAULT_DETAIL_TERMINAL_PANEL_STATE)
		: DEFAULT_DETAIL_TERMINAL_PANEL_STATE;
	const isDetailTerminalOpen = currentDetailTerminalPanelState.isOpen;
	const isDetailTerminalExpanded = currentDetailTerminalPanelState.isExpanded;
	const homeTerminalPaneHeight = computeTerminalPaneHeight(isHomeTerminalExpanded, lastBottomTerminalPaneHeight);
	const detailTerminalPaneHeight = computeTerminalPaneHeight(isDetailTerminalExpanded, lastBottomTerminalPaneHeight);

	useEffect(() => {
		detailTerminalPanelStateByTaskIdRef.current = detailTerminalPanelStateByTaskId;
	}, [detailTerminalPanelStateByTaskId]);

	const updateDetailTerminalPanelState = useCallback(
		(taskId: string, updater: (previous: DetailTerminalPanelState) => DetailTerminalPanelState) => {
			setDetailTerminalPanelStateByTaskId((previous) => ({
				...previous,
				[taskId]: updater(previous[taskId] ?? DEFAULT_DETAIL_TERMINAL_PANEL_STATE),
			}));
		},
		[],
	);

	const persistBottomTerminalPaneHeight = useCallback((height: number | undefined) => {
		if (typeof height !== "number" || !Number.isFinite(height)) {
			return;
		}
		const normalizedHeight = persistPaneHeight(height);
		setLastBottomTerminalPaneHeight(normalizedHeight);
	}, []);

	const resetBottomTerminalPaneHeight = useCallback(() => {
		setLastBottomTerminalPaneHeight(undefined);
		removeLocalStorageItem(LocalStorageKey.BottomTerminalPaneHeight);
	}, []);

	const resetBottomTerminalLayoutCustomizations = useCallback(() => {
		resetBottomTerminalPaneHeight();
		setIsHomeTerminalExpanded(false);
		setDetailTerminalPanelStateByTaskId(collapseAllDetailPanels);
	}, [resetBottomTerminalPaneHeight]);

	const waitForPendingShellStop = useCallback(async (projectId: string, taskId: string): Promise<void> => {
		const pendingStop = pendingShellStopsRef.current.get(buildShellStopKey(projectId, taskId));
		if (!pendingStop) {
			return;
		}
		// This replaces the old "preserve selection ref" guard: reopening a shell
		// must wait for the previous PTY stop to finish so startShellSession cannot
		// observe a still-live process and return the session we're trying to close.
		log.debug("waiting for previous shell stop before starting", { projectId, taskId });
		await pendingStop.catch(() => {});
	}, []);

	const stopShellTerminalSession = useCallback(
		async ({
			projectId,
			reason,
			taskId,
			waitForExit,
		}: {
			projectId: string;
			reason: string;
			taskId: string;
			waitForExit: boolean;
		}): Promise<void> => {
			const stopKey = buildShellStopKey(projectId, taskId);
			const pendingStop = pendingShellStopsRef.current.get(stopKey);
			if (pendingStop) {
				log.debug("shell terminal stop already pending", { projectId, taskId, reason });
				await pendingStop;
				return;
			}
			cancelPendingRestartRef.current?.(taskId);
			suppressNextShellExitRef.current?.(taskId);
			// Shell close/context-switch is an ownership boundary, not a
			// minimize action. Dispose the browser-side dedicated xterm slot
			// before stopping the PTY so closed shells do not leave parked
			// xterm instances, WebGL contexts, sockets, or helper textareas alive.
			disposeDedicatedTerminal(projectId, taskId);
			const trpcClient = getRuntimeTrpcClient(projectId);
			const stopPromise = (async () => {
				try {
					log.info("stopping shell terminal", { projectId, taskId, reason, waitForExit });
					const payload = await trpcClient.runtime.stopTaskSession.mutate({ taskId, waitForExit });
					if (!payload.ok) {
						throw new Error(payload.error ?? "Could not stop terminal session.");
					}
					if (payload.summary) {
						upsertSession(payload.summary);
					}
				} finally {
					clearSuppressedShellExitRef.current?.(taskId);
				}
			})();
			pendingShellStopsRef.current.set(stopKey, stopPromise);
			const clearPendingStop = () => {
				if (pendingShellStopsRef.current.get(stopKey) === stopPromise) {
					pendingShellStopsRef.current.delete(stopKey);
				}
			};
			void stopPromise.then(clearPendingStop, clearPendingStop);
			await stopPromise;
		},
		[upsertSession],
	);

	const stopShellTerminalSessionInBackground = useCallback(
		(input: { projectId: string; reason: string; taskId: string; waitForExit: boolean }) => {
			void stopShellTerminalSession(input).catch((error) => {
				log.warn("failed to stop shell terminal", {
					projectId: input.projectId,
					taskId: input.taskId,
					reason: input.reason,
					error: toErrorMessage(error),
				});
			});
		},
		[stopShellTerminalSession],
	);

	const closeHomeTerminal = useCallback(() => {
		// Only stop the backing PTY when we actually opened one for a project.
		// The ref is populated when the home shell starts; a null ref means the
		// terminal was never opened (e.g. during project-switch reset), so there
		// is nothing to stop and asking the runtime to stop it would be a no-op
		// that surfaces as a "no session" failure.
		const projectId = homeTerminalProjectIdRef.current;
		setIsHomeTerminalOpen(false);
		setIsHomeTerminalExpanded(false);
		setHomeTerminalShellBinary(null);
		homeTerminalProjectIdRef.current = null;
		if (projectId) {
			stopShellTerminalSessionInBackground({
				projectId,
				taskId: HOME_TERMINAL_TASK_ID,
				reason: "close",
				waitForExit: true,
			});
		}
	}, [stopShellTerminalSessionInBackground]);

	const closeDetailTerminalByTaskId = useCallback(
		(taskId: string, reason = "close") => {
			const wasOpen = detailTerminalPanelStateByTaskIdRef.current[taskId]?.isOpen === true;
			updateDetailTerminalPanelState(taskId, () => DEFAULT_DETAIL_TERMINAL_PANEL_STATE);
			const projectId = detailTerminalProjectIdByTaskIdRef.current[taskId] ?? (wasOpen ? currentProjectId : null);
			delete detailTerminalProjectIdByTaskIdRef.current[taskId];
			if (detailTerminalTaskId === taskId) {
				detailTerminalSelectionKeyRef.current = null;
			}
			if (projectId) {
				stopShellTerminalSessionInBackground({ projectId, taskId, reason, waitForExit: true });
			}
		},
		[currentProjectId, detailTerminalTaskId, stopShellTerminalSessionInBackground, updateDetailTerminalPanelState],
	);

	const closeDetailTerminal = useCallback(() => {
		if (!detailTerminalTaskId) {
			detailTerminalSelectionKeyRef.current = null;
			return;
		}
		closeDetailTerminalByTaskId(detailTerminalTaskId);
	}, [closeDetailTerminalByTaskId, detailTerminalTaskId]);

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
			if (isHomeTerminalExpanded) {
				return;
			}
			persistBottomTerminalPaneHeight(height);
		},
		[isHomeTerminalExpanded, persistBottomTerminalPaneHeight],
	);

	const setDetailTerminalPaneHeight = useCallback(
		(height: number | undefined) => {
			if (isDetailTerminalExpanded) {
				return;
			}
			persistBottomTerminalPaneHeight(height);
		},
		[isDetailTerminalExpanded, persistBottomTerminalPaneHeight],
	);

	const handleToggleExpandHomeTerminal = useCallback(() => {
		setIsHomeTerminalExpanded((previous) => !previous);
	}, []);

	const handleToggleExpandDetailTerminal = useCallback(() => {
		if (!detailTerminalTaskId) {
			return;
		}
		updateDetailTerminalPanelState(detailTerminalTaskId, (previous) => ({
			...previous,
			isExpanded: !previous.isExpanded,
		}));
	}, [detailTerminalTaskId, updateDetailTerminalPanelState]);

	const startHomeTerminalSession = useCallback(async (): Promise<boolean> => {
		if (!currentProjectId) {
			return false;
		}
		setIsHomeTerminalStarting(true);
		try {
			homeTerminalProjectIdRef.current = currentProjectId;
			await waitForPendingShellStop(currentProjectId, HOME_TERMINAL_TASK_ID);
			const geometry = await resolveShellTerminalGeometry(HOME_TERMINAL_TASK_ID);
			const trpcClient = getRuntimeTrpcClient(currentProjectId);
			log.info("starting home shell terminal", { projectId: currentProjectId, taskId: HOME_TERMINAL_TASK_ID });
			const payload = await trpcClient.runtime.startShellSession.mutate({
				taskId: HOME_TERMINAL_TASK_ID,
				cols: geometry.cols,
				rows: geometry.rows,
				baseRef: projectGit?.currentBranch ?? (configDefaultBaseRef || projectGit?.defaultBranch) ?? "HEAD",
			});
			if (!payload.ok || !payload.summary) {
				throw new Error(payload.error ?? "Could not start terminal session.");
			}
			upsertSession(payload.summary);
			setHomeTerminalShellBinary(
				typeof payload.shellBinary === "string" && payload.shellBinary.trim() ? payload.shellBinary : null,
			);
			return true;
		} catch (error) {
			const message = toErrorMessage(error);
			notifyError(message);
			return false;
		} finally {
			setIsHomeTerminalStarting(false);
		}
	}, [
		configDefaultBaseRef,
		currentProjectId,
		upsertSession,
		projectGit?.currentBranch,
		projectGit?.defaultBranch,
		waitForPendingShellStop,
	]);

	const handleToggleHomeTerminal = useCallback(() => {
		if (isHomeTerminalOpen) {
			closeHomeTerminal();
			return;
		}
		if (!currentProjectId) {
			return;
		}
		homeTerminalProjectIdRef.current = currentProjectId;
		setIsHomeTerminalOpen(true);
		void startHomeTerminalSession();
	}, [closeHomeTerminal, currentProjectId, isHomeTerminalOpen, startHomeTerminalSession]);

	const startDetailTerminalForCard = useCallback(
		async (card: BoardCard, options?: StartDetailTerminalOptions): Promise<boolean> => {
			if (!currentProjectId) {
				return false;
			}
			const showLoading = options?.showLoading ?? false;
			if (showLoading) {
				setIsDetailTerminalStarting(true);
			}
			try {
				const targetTaskId = getDetailTerminalTaskId(card.id);
				detailTerminalProjectIdByTaskIdRef.current[targetTaskId] = currentProjectId;
				await waitForPendingShellStop(currentProjectId, targetTaskId);
				const geometry = await resolveShellTerminalGeometry(targetTaskId);
				const trpcClient = getRuntimeTrpcClient(currentProjectId);
				log.info("starting detail shell terminal", {
					projectId: currentProjectId,
					taskId: targetTaskId,
					projectTaskId: card.id,
				});
				const payload = await trpcClient.runtime.startShellSession.mutate({
					taskId: targetTaskId,
					cols: geometry.cols,
					rows: geometry.rows,
					projectTaskId: card.id,
					baseRef: card.baseRef,
				});
				if (!payload.ok || !payload.summary) {
					throw new Error(payload.error ?? "Could not start detail terminal session.");
				}
				upsertSession(payload.summary);
				return true;
			} catch (error) {
				const message = toErrorMessage(error);
				notifyError(message);
				return false;
			} finally {
				if (showLoading) {
					setIsDetailTerminalStarting(false);
				}
			}
		},
		[currentProjectId, upsertSession, waitForPendingShellStop],
	);

	const handleToggleDetailTerminal = useCallback(() => {
		if (!selectedCard) {
			return;
		}
		const targetTaskId = getDetailTerminalTaskId(selectedCard.card.id);
		if (isDetailTerminalOpen) {
			closeDetailTerminal();
			return;
		}
		updateDetailTerminalPanelState(targetTaskId, (previous) => ({
			...previous,
			isOpen: true,
		}));
		void (async () => {
			const selectionKey = `${selectedCard.card.id}:${selectedCard.card.baseRef}`;
			detailTerminalSelectionKeyRef.current = selectionKey;
			const started = await startDetailTerminalForCard(selectedCard.card, { showLoading: true });
			if (!started && detailTerminalSelectionKeyRef.current === selectionKey) {
				detailTerminalSelectionKeyRef.current = null;
			}
		})();
	}, [
		closeDetailTerminal,
		isDetailTerminalOpen,
		selectedCard,
		startDetailTerminalForCard,
		updateDetailTerminalPanelState,
	]);

	useEffect(() => {
		const previousTaskId = previousDetailTerminalTaskIdRef.current;
		const previousTaskHadShell =
			previousTaskId !== null &&
			(detailTerminalPanelStateByTaskIdRef.current[previousTaskId]?.isOpen === true ||
				detailTerminalProjectIdByTaskIdRef.current[previousTaskId] !== undefined);
		if (previousTaskId && previousTaskId !== detailTerminalTaskId && previousTaskHadShell) {
			closeDetailTerminalByTaskId(previousTaskId, "context-change");
		}
		previousDetailTerminalTaskIdRef.current = detailTerminalTaskId;
	}, [closeDetailTerminalByTaskId, detailTerminalTaskId]);

	useEffect(() => {
		if (selectedCard && isHomeTerminalOpen) {
			closeHomeTerminal();
		}
	}, [closeHomeTerminal, isHomeTerminalOpen, selectedCard]);

	useEffect(() => {
		if (!isDetailTerminalOpen || !selectedCard) {
			if (!selectedCard) {
				detailTerminalSelectionKeyRef.current = null;
			}
			return;
		}
		const selectionKey = `${selectedCard.card.id}:${selectedCard.card.baseRef}`;
		if (detailTerminalSelectionKeyRef.current === selectionKey) {
			return;
		}
		detailTerminalSelectionKeyRef.current = selectionKey;
		void startDetailTerminalForCard(selectedCard.card);
	}, [isDetailTerminalOpen, selectedCard?.card.baseRef, selectedCard?.card.id, startDetailTerminalForCard]);

	useEffect(() => {
		if (!isHomeTerminalOpen) {
			homeTerminalProjectIdRef.current = null;
			return;
		}
		if (!currentProjectId || homeTerminalProjectIdRef.current === currentProjectId) {
			return;
		}
		const previousProjectId = homeTerminalProjectIdRef.current;
		if (previousProjectId) {
			stopShellTerminalSessionInBackground({
				projectId: previousProjectId,
				taskId: HOME_TERMINAL_TASK_ID,
				reason: "project-change",
				waitForExit: true,
			});
		}
		homeTerminalProjectIdRef.current = currentProjectId;
		void (async () => {
			const started = await startHomeTerminalSession();
			if (!started) {
				closeHomeTerminal();
			}
		})();
	}, [
		closeHomeTerminal,
		currentProjectId,
		isHomeTerminalOpen,
		startHomeTerminalSession,
		stopShellTerminalSessionInBackground,
	]);

	const restartTerminal = useCallback(
		(taskId: string, startFn: () => Promise<boolean>) => {
			const projectId =
				taskId === HOME_TERMINAL_TASK_ID
					? (homeTerminalProjectIdRef.current ?? currentProjectId)
					: (detailTerminalProjectIdByTaskIdRef.current[taskId] ?? currentProjectId);
			if (!projectId) {
				return;
			}
			cancelPendingRestartRef.current?.(taskId);
			void (async () => {
				await stopShellTerminalSession({ projectId, taskId, reason: "restart", waitForExit: true });
				await startFn();
			})().catch(notifyError);
		},
		[currentProjectId, stopShellTerminalSession],
	);

	const handleRestartHomeTerminal = useCallback(() => {
		restartTerminal(HOME_TERMINAL_TASK_ID, startHomeTerminalSession);
	}, [restartTerminal, startHomeTerminalSession]);

	const handleRestartDetailTerminal = useCallback(() => {
		if (!selectedCard) {
			return;
		}
		const card = selectedCard.card;
		const targetTaskId = getDetailTerminalTaskId(card.id);
		restartTerminal(targetTaskId, () => startDetailTerminalForCard(card));
	}, [restartTerminal, selectedCard, startDetailTerminalForCard]);

	const handleRestartDetailTerminalById = useCallback(
		(cardId: string) => {
			const card = findCard(cardId);
			if (!card) {
				console.warn(`[shell-auto-restart] Could not find card for id: ${cardId}`);
				return;
			}
			const targetTaskId = getDetailTerminalTaskId(cardId);
			restartTerminal(targetTaskId, () => startDetailTerminalForCard(card));
		},
		[findCard, restartTerminal, startDetailTerminalForCard],
	);

	const { handleShellExit, cancelPendingRestart, suppressNextExit, clearSuppressedExit } = useShellAutoRestart({
		shellAutoRestartEnabled,
		restartHomeTerminal: handleRestartHomeTerminal,
		restartDetailTerminal: handleRestartDetailTerminalById,
		writeToTerminal: (taskId, msg) => {
			if (currentProjectId) {
				writeToTerminalBuffer(currentProjectId, taskId, msg);
			}
		},
		isSessionRunning: (taskId) => (currentProjectId ? isTerminalSessionRunning(currentProjectId, taskId) : false),
	});
	cancelPendingRestartRef.current = cancelPendingRestart;
	suppressNextShellExitRef.current = suppressNextExit;
	clearSuppressedShellExitRef.current = clearSuppressedExit;

	const handleSendAgentCommandToHomeTerminal = useCallback(() => {
		if (!agentCommand) {
			return;
		}
		void sendTaskSessionInput(HOME_TERMINAL_TASK_ID, agentCommand, { appendNewline: true });
	}, [agentCommand, sendTaskSessionInput]);

	const handleSendAgentCommandToDetailTerminal = useCallback(() => {
		if (!agentCommand || !selectedCard) {
			return;
		}
		const terminalTaskId = getDetailTerminalTaskId(selectedCard.card.id);
		void sendTaskSessionInput(terminalTaskId, agentCommand, { appendNewline: true });
	}, [agentCommand, selectedCard, sendTaskSessionInput]);

	const prepareTerminalForShortcut = useCallback(
		async ({ prepareWaitForTerminalConnectionReady }: PrepareTerminalForShortcutInput) => {
			let targetTaskId = HOME_TERMINAL_TASK_ID;
			let hadExistingOpenTerminal = false;
			let shouldWaitForConnection = false;
			let waitForTerminalConnectionReady: (() => Promise<void>) | null = null;
			const activeSelection = selectedCard;
			if (activeSelection) {
				targetTaskId = getDetailTerminalTaskId(activeSelection.card.id);
				const selectionKey = `${activeSelection.card.id}:${activeSelection.card.baseRef}`;
				const detailWasAlreadyOpenForSelection =
					isDetailTerminalOpen && detailTerminalSelectionKeyRef.current === selectionKey;
				hadExistingOpenTerminal = detailWasAlreadyOpenForSelection;
				shouldWaitForConnection = !detailWasAlreadyOpenForSelection;
				if (shouldWaitForConnection) {
					waitForTerminalConnectionReady = prepareWaitForTerminalConnectionReady(targetTaskId);
					detailTerminalSelectionKeyRef.current = selectionKey;
					updateDetailTerminalPanelState(targetTaskId, (previous) => ({
						...previous,
						isOpen: true,
					}));
					const started = await startDetailTerminalForCard(activeSelection.card, { showLoading: true });
					if (!started) {
						if (detailTerminalSelectionKeyRef.current === selectionKey) {
							detailTerminalSelectionKeyRef.current = null;
						}
						return {
							ok: false,
							message: "Could not open detail terminal.",
						} satisfies PrepareTerminalForShortcutResult;
					}
				}
			} else {
				const homeWasAlreadyOpenForProject =
					isHomeTerminalOpen && homeTerminalProjectIdRef.current === currentProjectId;
				hadExistingOpenTerminal = homeWasAlreadyOpenForProject;
				shouldWaitForConnection = !homeWasAlreadyOpenForProject;
				if (shouldWaitForConnection) {
					waitForTerminalConnectionReady = prepareWaitForTerminalConnectionReady(HOME_TERMINAL_TASK_ID);
					homeTerminalProjectIdRef.current = currentProjectId;
					setIsHomeTerminalOpen(true);
					const started = await startHomeTerminalSession();
					if (!started) {
						closeHomeTerminal();
						return {
							ok: false,
							message: "Could not open terminal.",
						} satisfies PrepareTerminalForShortcutResult;
					}
				}
			}

			if (shouldWaitForConnection && waitForTerminalConnectionReady) {
				await waitForTerminalConnectionReady();
			}

			return {
				hadExistingOpenTerminal,
				ok: true,
				targetTaskId,
			} satisfies PrepareTerminalForShortcutResult;
		},
		[
			closeHomeTerminal,
			currentProjectId,
			isDetailTerminalOpen,
			isHomeTerminalOpen,
			selectedCard,
			startDetailTerminalForCard,
			startHomeTerminalSession,
			updateDetailTerminalPanelState,
		],
	);

	const closeAllDetailTerminals = useCallback(
		(reason: string) => {
			const taskIds = new Set<string>([
				...Object.keys(detailTerminalPanelStateByTaskIdRef.current),
				...Object.keys(detailTerminalProjectIdByTaskIdRef.current),
			]);
			for (const taskId of taskIds) {
				closeDetailTerminalByTaskId(taskId, reason);
			}
			detailTerminalProjectIdByTaskIdRef.current = {};
			detailTerminalSelectionKeyRef.current = null;
			setDetailTerminalPanelStateByTaskId({});
		},
		[closeDetailTerminalByTaskId],
	);

	const resetTerminalPanelsState = useCallback(() => {
		closeHomeTerminal();
		setIsHomeTerminalStarting(false);
		setHomeTerminalShellBinary(null);
		closeAllDetailTerminals("reset");
		setIsDetailTerminalStarting(false);
	}, [closeAllDetailTerminals, closeHomeTerminal]);

	return {
		homeTerminalTaskId: HOME_TERMINAL_TASK_ID,
		isHomeTerminalOpen,
		isHomeTerminalStarting,
		homeTerminalShellBinary,
		homeTerminalPaneHeight,
		isDetailTerminalOpen,
		detailTerminalTaskId,
		isDetailTerminalStarting,
		detailTerminalPaneHeight,
		isHomeTerminalExpanded,
		isDetailTerminalExpanded,
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
		resetTerminalPanelsState,
		handleShellExit,
		cancelPendingRestart,
	};
}
