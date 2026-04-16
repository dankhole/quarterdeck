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

export {
	DETAIL_TERMINAL_TASK_PREFIX,
	getDetailTerminalTaskId,
	HOME_TERMINAL_TASK_ID,
} from "@/terminal/terminal-constants";

import type { SendTerminalInputOptions } from "@/terminal/terminal-input";
import { isTerminalSessionRunning, writeToTerminalBuffer } from "@/terminal/terminal-pool";
import type { BoardCard, CardSelection } from "@/types";
import { toErrorMessage } from "@/utils/to-error-message";

interface StartDetailTerminalOptions {
	showLoading?: boolean;
}

interface UseTerminalPanelsInput {
	currentProjectId: string | null;
	selectedCard: CardSelection | null;
	workspaceGit: RuntimeGitRepositoryInfo | null;
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
	workspaceGit,
	configDefaultBaseRef,
	agentCommand,
	shellAutoRestartEnabled,
	findCard,
	upsertSession,
	sendTaskSessionInput,
}: UseTerminalPanelsInput): UseTerminalPanelsResult {
	const homeTerminalProjectIdRef = useRef<string | null>(null);
	const detailTerminalSelectionKeyRef = useRef<string | null>(null);
	const [isHomeTerminalOpen, setIsHomeTerminalOpen] = useState(false);
	const [isHomeTerminalStarting, setIsHomeTerminalStarting] = useState(false);
	const [homeTerminalShellBinary, setHomeTerminalShellBinary] = useState<string | null>(null);
	const [lastBottomTerminalPaneHeight, setLastBottomTerminalPaneHeight] = useState<number | undefined>(
		loadBottomTerminalPaneHeight,
	);
	const [detailTerminalPanelStateByTaskId, setDetailTerminalPanelStateByTaskId] = useState<
		Record<string, DetailTerminalPanelState>
	>({});
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

	const closeHomeTerminal = useCallback(() => {
		setIsHomeTerminalOpen(false);
		setIsHomeTerminalExpanded(false);
		homeTerminalProjectIdRef.current = null;
	}, []);

	const closeDetailTerminal = useCallback(() => {
		if (detailTerminalTaskId) {
			updateDetailTerminalPanelState(detailTerminalTaskId, () => DEFAULT_DETAIL_TERMINAL_PANEL_STATE);
		}
		detailTerminalSelectionKeyRef.current = null;
	}, [detailTerminalTaskId, updateDetailTerminalPanelState]);

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
			const geometry = await resolveShellTerminalGeometry(HOME_TERMINAL_TASK_ID);
			const trpcClient = getRuntimeTrpcClient(currentProjectId);
			const payload = await trpcClient.runtime.startShellSession.mutate({
				taskId: HOME_TERMINAL_TASK_ID,
				cols: geometry.cols,
				rows: geometry.rows,
				baseRef: workspaceGit?.currentBranch ?? (configDefaultBaseRef || workspaceGit?.defaultBranch) ?? "HEAD",
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
		workspaceGit?.currentBranch,
		workspaceGit?.defaultBranch,
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
				const geometry = await resolveShellTerminalGeometry(targetTaskId);
				const trpcClient = getRuntimeTrpcClient(currentProjectId);
				const payload = await trpcClient.runtime.startShellSession.mutate({
					taskId: targetTaskId,
					cols: geometry.cols,
					rows: geometry.rows,
					workspaceTaskId: card.id,
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
		[currentProjectId, upsertSession],
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
		if (!isDetailTerminalOpen || !selectedCard) {
			// Only clear the ref when no card is selected (user left detail view).
			// When switching between tasks, preserve the ref so we don't redundantly
			// call startShellSession when returning — that call can kill a running
			// shell if the session state drifted from "running" while off-screen.
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
		homeTerminalProjectIdRef.current = currentProjectId;
		void (async () => {
			const started = await startHomeTerminalSession();
			if (!started) {
				closeHomeTerminal();
			}
		})();
	}, [closeHomeTerminal, currentProjectId, isHomeTerminalOpen, startHomeTerminalSession]);

	const cancelPendingRestartRef = useRef<((taskId: string) => void) | null>(null);

	const restartTerminal = useCallback(
		(taskId: string, startFn: () => Promise<boolean>) => {
			if (!currentProjectId) {
				return;
			}
			cancelPendingRestartRef.current?.(taskId);
			const trpcClient = getRuntimeTrpcClient(currentProjectId);
			void (async () => {
				await trpcClient.runtime.stopTaskSession.mutate({ taskId });
				await startFn();
			})().catch(notifyError);
		},
		[currentProjectId],
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

	const { handleShellExit, cancelPendingRestart } = useShellAutoRestart({
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
				}
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
			} else {
				const homeWasAlreadyOpenForProject =
					isHomeTerminalOpen && homeTerminalProjectIdRef.current === currentProjectId;
				hadExistingOpenTerminal = homeWasAlreadyOpenForProject;
				shouldWaitForConnection = !homeWasAlreadyOpenForProject;
				if (shouldWaitForConnection) {
					waitForTerminalConnectionReady = prepareWaitForTerminalConnectionReady(HOME_TERMINAL_TASK_ID);
				}
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

	const resetTerminalPanelsState = useCallback(() => {
		closeHomeTerminal();
		setIsHomeTerminalStarting(false);
		setHomeTerminalShellBinary(null);
		setDetailTerminalPanelStateByTaskId({});
		detailTerminalSelectionKeyRef.current = null;
		setIsDetailTerminalStarting(false);
	}, [closeHomeTerminal]);

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
