import { useCallback, useEffect, useRef } from "react";

import { getRuntimeTrpcClient } from "@/runtime/trpc-client";
import type { RuntimeWorkspaceChangesResponse } from "@/runtime/types";
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
	stateVersion = 0,
	pollIntervalMs: number | null = null,
): UseRuntimeWorkspaceChangesResult {
	const hasWorkspaceScope = taskId !== null && workspaceId !== null && baseRef !== null;
	const queryFn = useCallback(async () => {
		if (!taskId || !workspaceId || !baseRef) {
			throw new Error("Missing workspace scope.");
		}
		const trpcClient = getRuntimeTrpcClient(workspaceId);
		return await trpcClient.workspace.getChanges.query({
			taskId,
			baseRef,
		});
	}, [baseRef, taskId, workspaceId]);
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
		if (!hasWorkspaceScope) {
			previousStateVersionRef.current = stateVersion;
			return;
		}
		if (previousStateVersionRef.current === stateVersion) {
			return;
		}
		previousStateVersionRef.current = stateVersion;
		void changesQuery.refetch();
	}, [changesQuery.refetch, hasWorkspaceScope, stateVersion]);

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

	if (!taskId) {
		return {
			changes: null,
			isLoading: false,
			isRuntimeAvailable: true,
			refresh,
		};
	}

	if (!workspaceId) {
		return {
			changes: null,
			isLoading: false,
			isRuntimeAvailable: false,
			refresh,
		};
	}

	return {
		changes: changesQuery.data,
		isLoading: changesQuery.isLoading,
		isRuntimeAvailable: !changesQuery.isError,
		refresh,
	};
}
