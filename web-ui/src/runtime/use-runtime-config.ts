import { useCallback, useEffect, useRef, useState } from "react";

import { fetchRuntimeConfig, saveRuntimeConfig } from "@/runtime/runtime-config-query";
import type { PromptShortcut, RuntimeAgentId, RuntimeConfigResponse, RuntimeProjectShortcut } from "@/runtime/types";
import { useTrpcQuery } from "@/runtime/use-trpc-query";

export interface UseRuntimeConfigResult {
	config: RuntimeConfigResponse | null;
	isLoading: boolean;
	isSaving: boolean;
	refresh: () => void;
	save: (nextConfig: {
		selectedAgentId?: RuntimeAgentId;
		selectedShortcutLabel?: string | null;
		agentAutonomousModeEnabled?: boolean;
		shortcuts?: RuntimeProjectShortcut[];
		promptShortcuts?: PromptShortcut[];
		readyForReviewNotificationsEnabled?: boolean;
		shellAutoRestartEnabled?: boolean;
		terminalFontWeight?: number;
		terminalWebGLRenderer?: boolean;
		terminalChatViewEnabled?: boolean;
		showSummaryOnCards?: boolean;
		autoGenerateSummary?: boolean;
		summaryStaleAfterSeconds?: number;
		showTrashWorktreeNotice?: boolean;
		uncommittedChangesOnCardsEnabled?: boolean;
		unmergedChangesIndicatorEnabled?: boolean;
		behindBaseIndicatorEnabled?: boolean;
		skipTaskCheckoutConfirmation?: boolean;
		skipHomeCheckoutConfirmation?: boolean;
		showRunningTaskEmergencyActions?: boolean;
		commitPromptTemplate?: string;
		openPrPromptTemplate?: string;
		audibleNotificationsEnabled?: boolean;
		audibleNotificationVolume?: number;
		audibleNotificationEvents?: {
			permission: boolean;
			review: boolean;
			failure: boolean;
			completion: boolean;
		};
		audibleNotificationsOnlyWhenHidden?: boolean;
		focusedTaskPollMs?: number;
		backgroundTaskPollMs?: number;
		homeRepoPollMs?: number;
	}) => Promise<RuntimeConfigResponse | null>;
}

export function useRuntimeConfig(
	open: boolean,
	workspaceId: string | null,
	initialConfig: RuntimeConfigResponse | null = null,
): UseRuntimeConfigResult {
	const [isSaving, setIsSaving] = useState(false);
	const previousWorkspaceIdRef = useRef<string | null>(null);
	const didRetryAfterInitialErrorRef = useRef(false);
	const lastLoggedErrorKeyRef = useRef<string | null>(null);
	const queryFn = useCallback(async () => await fetchRuntimeConfig(workspaceId), [workspaceId]);
	const configQuery = useTrpcQuery<RuntimeConfigResponse>({
		enabled: open,
		queryFn,
		retainDataOnError: true,
	});
	const setConfigData = configQuery.setData;

	useEffect(() => {
		const workspaceChanged = previousWorkspaceIdRef.current !== workspaceId;
		previousWorkspaceIdRef.current = workspaceId;
		if (workspaceChanged) {
			didRetryAfterInitialErrorRef.current = false;
			lastLoggedErrorKeyRef.current = null;
			setConfigData(initialConfig);
			return;
		}
		if (configQuery.data === null && initialConfig !== null) {
			setConfigData(initialConfig);
		}
	}, [configQuery.data, initialConfig, setConfigData, workspaceId]);

	useEffect(() => {
		if (!open || configQuery.data !== null) {
			didRetryAfterInitialErrorRef.current = false;
			lastLoggedErrorKeyRef.current = null;
			return;
		}
		if (!configQuery.isError) {
			return;
		}
		const scopeLabel = workspaceId ?? "global";
		const message = configQuery.error?.message ?? "Unknown runtime config load error.";
		const errorKey = `${scopeLabel}:${message}`;
		if (lastLoggedErrorKeyRef.current !== errorKey) {
			console.warn(`[quarterdeck][settings] runtime.getConfig failed for scope ${scopeLabel}: ${message}`);
			lastLoggedErrorKeyRef.current = errorKey;
		}
		if (didRetryAfterInitialErrorRef.current) {
			return;
		}
		didRetryAfterInitialErrorRef.current = true;
		console.warn(`[quarterdeck][settings] Retrying runtime.getConfig once for scope ${scopeLabel}.`);
		void configQuery.refetch();
	}, [configQuery.data, configQuery.error, configQuery.isError, configQuery.refetch, open, workspaceId]);

	const save = useCallback(
		async (nextConfig: {
			selectedAgentId?: RuntimeAgentId;
			selectedShortcutLabel?: string | null;
			agentAutonomousModeEnabled?: boolean;
			shortcuts?: RuntimeProjectShortcut[];
			promptShortcuts?: PromptShortcut[];
			readyForReviewNotificationsEnabled?: boolean;
			shellAutoRestartEnabled?: boolean;
			terminalFontWeight?: number;
			terminalWebGLRenderer?: boolean;
			showSummaryOnCards?: boolean;
			autoGenerateSummary?: boolean;
			summaryStaleAfterSeconds?: number;
			showTrashWorktreeNotice?: boolean;
			uncommittedChangesOnCardsEnabled?: boolean;
			unmergedChangesIndicatorEnabled?: boolean;
			behindBaseIndicatorEnabled?: boolean;
			skipTaskCheckoutConfirmation?: boolean;
			skipHomeCheckoutConfirmation?: boolean;
			showRunningTaskEmergencyActions?: boolean;
			commitPromptTemplate?: string;
			openPrPromptTemplate?: string;
			audibleNotificationsEnabled?: boolean;
			audibleNotificationVolume?: number;
			audibleNotificationEvents?: {
				permission: boolean;
				review: boolean;
				failure: boolean;
				completion: boolean;
			};
			audibleNotificationsOnlyWhenHidden?: boolean;
		}): Promise<RuntimeConfigResponse | null> => {
			setIsSaving(true);
			try {
				const saved = await saveRuntimeConfig(workspaceId, nextConfig);
				setConfigData(saved);
				return saved;
			} catch {
				return null;
			} finally {
				setIsSaving(false);
			}
		},
		[setConfigData, workspaceId],
	);

	const refresh = useCallback(() => {
		void configQuery.refetch();
	}, [configQuery.refetch]);

	return {
		config: configQuery.data ?? initialConfig,
		isLoading: open ? configQuery.isLoading && configQuery.data === null && initialConfig === null : false,
		isSaving,
		refresh,
		save,
	};
}
