import { useCallback, useEffect, useRef } from "react";

import { getRuntimeTrpcClient } from "@/runtime/trpc-client";
import type { RuntimeDiffMode, RuntimeWorkdirChangesMode, RuntimeWorkdirChangesResponse } from "@/runtime/types";
import { useTrpcQuery } from "@/runtime/use-trpc-query";

export interface UseRuntimeProjectChangesResult {
	changes: RuntimeWorkdirChangesResponse | null;
	isLoading: boolean;
	isRuntimeAvailable: boolean;
	refresh: () => Promise<void>;
}

export function useRuntimeProjectChanges(
	taskId: string | null,
	projectId: string | null,
	baseRef: string | null,
	mode: RuntimeWorkdirChangesMode = "working_copy",
	stateVersion = 0,
	pollIntervalMs: number | null = null,
	viewKey: string | null = null,
	clearOnViewTransition = true,
	fromRef?: string | null,
	toRef?: string | null,
	diffMode?: RuntimeDiffMode | null,
): UseRuntimeProjectChangesResult {
	// projectId is always required. The backend handles null taskId (home context) and fromRef/toRef (compare).
	const hasProjectScope = projectId !== null;
	const normalizedViewKey = viewKey ?? "__default__";
	const requestKey = `${projectId ?? "__none__"}:${taskId ?? "__none__"}:${baseRef ?? "__none__"}:${mode}:${normalizedViewKey}:${fromRef ?? ""}:${toRef ?? ""}:${diffMode ?? ""}`;
	const previousRequestKeyRef = useRef(requestKey);
	const isRequestTransitioning = hasProjectScope && previousRequestKeyRef.current !== requestKey;
	const queryFn = useCallback(async () => {
		if (!projectId) {
			throw new Error("Missing project scope.");
		}
		void normalizedViewKey;
		const trpcClient = getRuntimeTrpcClient(projectId);
		return await trpcClient.project.getChanges.query({
			taskId: taskId ?? null,
			baseRef: baseRef ?? undefined,
			mode,
			...(fromRef ? { fromRef } : {}),
			...(toRef ? { toRef } : {}),
			...(diffMode ? { diffMode } : {}),
		});
	}, [baseRef, diffMode, fromRef, mode, normalizedViewKey, taskId, toRef, projectId]);
	const changesQuery = useTrpcQuery<RuntimeWorkdirChangesResponse>({
		enabled: hasProjectScope,
		queryFn,
	});

	const refresh = useCallback(async () => {
		if (!hasProjectScope) {
			return;
		}
		await changesQuery.refetch();
	}, [changesQuery.refetch, hasProjectScope]);
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
		if (!hasProjectScope) {
			previousRequestKeyRef.current = requestKey;
			previousStateVersionRef.current = stateVersion;
			return;
		}
		if (previousStateVersionRef.current === stateVersion) {
			return;
		}
		previousStateVersionRef.current = stateVersion;
		void changesQuery.refetch();
	}, [changesQuery.refetch, hasProjectScope, requestKey, stateVersion]);

	useEffect(() => {
		if (!hasProjectScope || pollIntervalMs == null) {
			return;
		}
		const interval = window.setInterval(() => {
			void changesQuery.refetch();
		}, pollIntervalMs);
		return () => {
			window.clearInterval(interval);
		};
	}, [changesQuery.refetch, hasProjectScope, pollIntervalMs]);

	if (!projectId) {
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
