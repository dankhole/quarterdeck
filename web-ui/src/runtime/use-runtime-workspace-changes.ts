import { useCallback, useEffect, useRef } from "react";

import { getRuntimeTrpcClient } from "@/runtime/trpc-client";
import type { RuntimeDiffMode, RuntimeWorkspaceChangesMode, RuntimeWorkspaceChangesResponse } from "@/runtime/types";
import { useTrpcQuery } from "@/runtime/use-trpc-query";

export interface UseRuntimeWorkspaceChangesResult {
	changes: RuntimeWorkspaceChangesResponse | null;
	isLoading: boolean;
	isRuntimeAvailable: boolean;
	refresh: () => Promise<void>;
}

export function useRuntimeWorkspaceChanges(
	taskId: string | null,
	workspaceId: string | null,
	baseRef: string | null,
	mode: RuntimeWorkspaceChangesMode = "working_copy",
	stateVersion = 0,
	pollIntervalMs: number | null = null,
	viewKey: string | null = null,
	clearOnViewTransition = true,
	fromRef?: string | null,
	toRef?: string | null,
	diffMode?: RuntimeDiffMode | null,
): UseRuntimeWorkspaceChangesResult {
	// workspaceId is always required. The backend handles null taskId (home context) and fromRef/toRef (compare).
	const hasWorkspaceScope = workspaceId !== null;
	const normalizedViewKey = viewKey ?? "__default__";
	const requestKey = `${workspaceId ?? "__none__"}:${taskId ?? "__none__"}:${baseRef ?? "__none__"}:${mode}:${normalizedViewKey}:${fromRef ?? ""}:${toRef ?? ""}:${diffMode ?? ""}`;
	const previousRequestKeyRef = useRef(requestKey);
	const isRequestTransitioning = hasWorkspaceScope && previousRequestKeyRef.current !== requestKey;
	const queryFn = useCallback(async () => {
		if (!workspaceId) {
			throw new Error("Missing workspace scope.");
		}
		void normalizedViewKey;
		const trpcClient = getRuntimeTrpcClient(workspaceId);
		return await trpcClient.workspace.getChanges.query({
			taskId: taskId ?? null,
			baseRef: baseRef ?? undefined,
			mode,
			...(fromRef ? { fromRef } : {}),
			...(toRef ? { toRef } : {}),
			...(diffMode ? { diffMode } : {}),
		});
	}, [baseRef, diffMode, fromRef, mode, normalizedViewKey, taskId, toRef, workspaceId]);
	const changesQuery = useTrpcQuery<RuntimeWorkspaceChangesResponse>({
		enabled: hasWorkspaceScope,
		queryFn,
	});

	const refresh = useCallback(async () => {
		if (!hasWorkspaceScope) {
			return;
		}
		await changesQuery.refetch();
	}, [changesQuery.refetch, hasWorkspaceScope]);
	const previousStateVersionRef = useRef(stateVersion);

	useEffect(() => {
		if (!isRequestTransitioning) {
			return;
		}
		previousRequestKeyRef.current = requestKey;
		if (clearOnViewTransition) {
			changesQuery.setData(null);
		}
	}, [changesQuery.setData, clearOnViewTransition, isRequestTransitioning, requestKey]);

	useEffect(() => {
		if (!hasWorkspaceScope) {
			previousRequestKeyRef.current = requestKey;
			previousStateVersionRef.current = stateVersion;
			return;
		}
		if (previousStateVersionRef.current === stateVersion) {
			return;
		}
		previousStateVersionRef.current = stateVersion;
		void changesQuery.refetch();
	}, [changesQuery.refetch, hasWorkspaceScope, requestKey, stateVersion]);

	useEffect(() => {
		if (!hasWorkspaceScope || pollIntervalMs == null) {
			return;
		}
		const interval = window.setInterval(() => {
			void changesQuery.refetch();
		}, pollIntervalMs);
		return () => {
			window.clearInterval(interval);
		};
	}, [changesQuery.refetch, hasWorkspaceScope, pollIntervalMs]);

	if (!workspaceId) {
		return {
			changes: null,
			isLoading: false,
			isRuntimeAvailable: false,
			refresh,
		};
	}

	const shouldHideDuringTransition = clearOnViewTransition && isRequestTransitioning;
	const visibleChanges = shouldHideDuringTransition ? null : changesQuery.data;
	const visibleIsLoading = shouldHideDuringTransition || changesQuery.isLoading;
	const visibleIsRuntimeAvailable = shouldHideDuringTransition ? true : !changesQuery.isError;

	return {
		changes: visibleChanges,
		isLoading: visibleIsLoading,
		isRuntimeAvailable: visibleIsRuntimeAvailable,
		refresh,
	};
}
