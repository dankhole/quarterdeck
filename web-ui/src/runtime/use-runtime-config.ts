import { useCallback, useEffect, useRef, useState } from "react";

import { fetchRuntimeConfig, saveRuntimeConfig } from "@/runtime/runtime-config-query";
import type { RuntimeAgentId, RuntimeConfigResponse, RuntimeProjectShortcut } from "@/runtime/types";
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
		readyForReviewNotificationsEnabled?: boolean;
		commitPromptTemplate?: string;
		openPrPromptTemplate?: string;
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
	const lastLoggedRetryExhaustedErrorKeyRef = useRef<string | null>(null);
	const lastRetriedScopeRef = useRef<string | null>(null);
	const queryFn = useCallback(async () => await fetchRuntimeConfig(workspaceId), [workspaceId]);
	const configQuery = useTrpcQuery<RuntimeConfigResponse>({
		enabled: open,
		queryFn,
		retainDataOnError: true,
	});
	const setConfigData = configQuery.setData;

	useEffect(() => {
		const workspaceChanged = previousWorkspaceIdRef.current !== workspaceId;
		const previousWorkspaceId = previousWorkspaceIdRef.current;
		previousWorkspaceIdRef.current = workspaceId;
		if (workspaceChanged) {
			if (open) {
				const previousScopeLabel = previousWorkspaceId ?? "global";
				const nextScopeLabel = workspaceId ?? "global";
				console.warn(
					`[kanban][settings] Settings scope changed from ${previousScopeLabel} to ${nextScopeLabel}; resetting runtime.getConfig retry state.`,
				);
			}
			didRetryAfterInitialErrorRef.current = false;
			lastLoggedErrorKeyRef.current = null;
			lastLoggedRetryExhaustedErrorKeyRef.current = null;
			lastRetriedScopeRef.current = null;
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
			lastLoggedRetryExhaustedErrorKeyRef.current = null;
			if (!open) {
				lastRetriedScopeRef.current = null;
			}
			return;
		}
		if (!configQuery.isError) {
			return;
		}
		const scopeLabel = workspaceId ?? "global";
		const message = configQuery.error?.message ?? "Unknown runtime config load error.";
		const errorKey = `${scopeLabel}:${message}`;
		if (lastLoggedErrorKeyRef.current !== errorKey) {
			console.warn(`[kanban][settings] runtime.getConfig failed for scope ${scopeLabel}: ${message}`);
			lastLoggedErrorKeyRef.current = errorKey;
		}
		if (didRetryAfterInitialErrorRef.current) {
			if (lastLoggedRetryExhaustedErrorKeyRef.current !== errorKey) {
				console.warn(`[kanban][settings] runtime.getConfig still failing after one retry for scope ${scopeLabel}.`);
				lastLoggedRetryExhaustedErrorKeyRef.current = errorKey;
			}
			return;
		}
		didRetryAfterInitialErrorRef.current = true;
		lastRetriedScopeRef.current = scopeLabel;
		console.warn(`[kanban][settings] Retrying runtime.getConfig once for scope ${scopeLabel}.`);
		void configQuery.refetch();
	}, [configQuery.data, configQuery.error, configQuery.isError, configQuery.refetch, open, workspaceId]);

	useEffect(() => {
		if (!open || configQuery.data === null) {
			return;
		}
		const scopeLabel = workspaceId ?? "global";
		if (lastRetriedScopeRef.current !== scopeLabel) {
			return;
		}
		console.warn(`[kanban][settings] runtime.getConfig recovered for scope ${scopeLabel} after retry.`);
		lastRetriedScopeRef.current = null;
	}, [configQuery.data, open, workspaceId]);

	const save = useCallback(
		async (nextConfig: {
			selectedAgentId?: RuntimeAgentId;
			selectedShortcutLabel?: string | null;
			agentAutonomousModeEnabled?: boolean;
			shortcuts?: RuntimeProjectShortcut[];
			readyForReviewNotificationsEnabled?: boolean;
			commitPromptTemplate?: string;
			openPrPromptTemplate?: string;
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
