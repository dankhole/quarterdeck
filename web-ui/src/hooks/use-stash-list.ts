import { useCallback, useEffect, useRef, useState } from "react";

import { showAppToast } from "@/components/app-toaster";
import { getRuntimeTrpcClient } from "@/runtime/trpc-client";
import type { RuntimeStashEntry } from "@/runtime/types";
import { useHomeStashCount, useTaskWorkspaceInfoValue } from "@/stores/workspace-metadata-store";

export interface UseStashListResult {
	entries: RuntimeStashEntry[];
	isLoading: boolean;
	isExpanded: boolean;
	setExpanded: (expanded: boolean) => void;
	popStash: (index: number) => Promise<void>;
	applyStash: (index: number) => Promise<void>;
	dropStash: (index: number) => Promise<void>;
	showStashDiff: (index: number) => Promise<string>;
}

export function useStashList(taskId: string | undefined, workspaceId: string): UseStashListResult {
	const [entries, setEntries] = useState<RuntimeStashEntry[]>([]);
	const [isLoading, setIsLoading] = useState(false);
	const [isExpanded, setIsExpanded] = useState(false);

	// Build taskScope from taskId + baseRef from the metadata store.
	const taskWorkspaceInfo = useTaskWorkspaceInfoValue(taskId ?? null);
	const baseRef = taskWorkspaceInfo?.baseRef ?? null;
	const taskScope = taskId && baseRef ? { taskId, baseRef } : null;

	// Track stash count changes from the metadata store.
	const homeStashCount = useHomeStashCount();

	// Stable ref for the latest taskScope to avoid stale closures in callbacks.
	const taskScopeRef = useRef(taskScope);
	taskScopeRef.current = taskScope;

	// Fetch the stash list from the server.
	const fetchStashList = useCallback(async () => {
		setIsLoading(true);
		try {
			const trpcClient = getRuntimeTrpcClient(workspaceId);
			const result = await trpcClient.workspace.stashList.query({ taskScope: taskScopeRef.current });
			if (result.ok) {
				setEntries(result.entries);
			} else {
				showAppToast({ intent: "danger", message: result.error ?? "Failed to load stash list.", timeout: 5000 });
			}
		} catch (error) {
			showAppToast({
				intent: "danger",
				message: error instanceof Error ? error.message : "Failed to load stash list.",
				timeout: 5000,
			});
		} finally {
			setIsLoading(false);
		}
	}, [workspaceId]);

	// Fetch when the section becomes expanded.
	useEffect(() => {
		if (isExpanded) {
			void fetchStashList();
		}
	}, [isExpanded, fetchStashList]);

	// Refetch when homeStashCount changes while expanded.
	const prevStashCountRef = useRef(homeStashCount);
	useEffect(() => {
		if (prevStashCountRef.current !== homeStashCount && isExpanded) {
			void fetchStashList();
		}
		prevStashCountRef.current = homeStashCount;
	}, [homeStashCount, isExpanded, fetchStashList]);

	const popStash = useCallback(
		async (index: number) => {
			try {
				const trpcClient = getRuntimeTrpcClient(workspaceId);
				const result = await trpcClient.workspace.stashPop.mutate({ taskScope: taskScopeRef.current, index });
				if (result.ok) {
					showAppToast({ intent: "success", message: "Stash popped.", timeout: 4000 });
				} else {
					showAppToast({ intent: "danger", message: result.error ?? "Pop failed.", timeout: 5000 });
				}
			} catch (error) {
				showAppToast({
					intent: "danger",
					message: error instanceof Error ? error.message : "Pop failed.",
					timeout: 5000,
				});
			}
			void fetchStashList();
		},
		[workspaceId, fetchStashList],
	);

	const applyStash = useCallback(
		async (index: number) => {
			try {
				const trpcClient = getRuntimeTrpcClient(workspaceId);
				const result = await trpcClient.workspace.stashApply.mutate({ taskScope: taskScopeRef.current, index });
				if (result.ok) {
					showAppToast({ intent: "success", message: "Stash applied.", timeout: 4000 });
				} else {
					showAppToast({ intent: "danger", message: result.error ?? "Apply failed.", timeout: 5000 });
				}
			} catch (error) {
				showAppToast({
					intent: "danger",
					message: error instanceof Error ? error.message : "Apply failed.",
					timeout: 5000,
				});
			}
			void fetchStashList();
		},
		[workspaceId, fetchStashList],
	);

	const dropStash = useCallback(
		async (index: number) => {
			try {
				const trpcClient = getRuntimeTrpcClient(workspaceId);
				const result = await trpcClient.workspace.stashDrop.mutate({ taskScope: taskScopeRef.current, index });
				if (result.ok) {
					showAppToast({ intent: "success", message: "Stash dropped.", timeout: 4000 });
				} else {
					showAppToast({ intent: "danger", message: result.error ?? "Drop failed.", timeout: 5000 });
				}
			} catch (error) {
				showAppToast({
					intent: "danger",
					message: error instanceof Error ? error.message : "Drop failed.",
					timeout: 5000,
				});
			}
			void fetchStashList();
		},
		[workspaceId, fetchStashList],
	);

	const showStashDiff = useCallback(
		async (index: number): Promise<string> => {
			try {
				const trpcClient = getRuntimeTrpcClient(workspaceId);
				const result = await trpcClient.workspace.stashShow.query({ taskScope: taskScopeRef.current, index });
				if (result.ok) {
					return result.diff ?? "";
				}
				showAppToast({ intent: "danger", message: result.error ?? "Failed to load stash diff.", timeout: 5000 });
				return "";
			} catch (error) {
				showAppToast({
					intent: "danger",
					message: error instanceof Error ? error.message : "Failed to load stash diff.",
					timeout: 5000,
				});
				return "";
			}
		},
		[workspaceId],
	);

	return {
		entries,
		isLoading,
		isExpanded,
		setExpanded: setIsExpanded,
		popStash,
		applyStash,
		dropStash,
		showStashDiff,
	};
}
