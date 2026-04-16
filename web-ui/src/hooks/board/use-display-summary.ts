import { useCallback, useEffect, useRef } from "react";
import { getRuntimeTrpcClient } from "@/runtime/trpc-client";

const HOVER_DEBOUNCE_MS = 800;

/**
 * Returns a debounced callback that triggers server-side display summary
 * generation for a task when hovered. The server handles staleness checks —
 * this hook only debounces to avoid spamming on rapid mouse movements.
 */
export function useDisplaySummaryOnHover(
	currentProjectId: string | null,
	autoGenerateSummary: boolean,
	staleAfterSeconds: number,
	llmConfigured: boolean,
): (taskId: string) => void {
	const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
	const lastRequestedRef = useRef<string | null>(null);

	useEffect(() => {
		return () => {
			if (timerRef.current !== null) {
				clearTimeout(timerRef.current);
			}
		};
	}, []);

	useEffect(() => {
		if ((!autoGenerateSummary || !llmConfigured) && timerRef.current !== null) {
			clearTimeout(timerRef.current);
			timerRef.current = null;
		}
	}, [autoGenerateSummary, llmConfigured]);

	return useCallback(
		(taskId: string) => {
			if (!autoGenerateSummary || !llmConfigured || !currentProjectId) {
				return;
			}

			// Don't re-request for the same task while the debounce is active.
			if (lastRequestedRef.current === taskId && timerRef.current !== null) {
				return;
			}

			if (timerRef.current !== null) {
				clearTimeout(timerRef.current);
			}
			lastRequestedRef.current = taskId;

			timerRef.current = setTimeout(() => {
				timerRef.current = null;
				const trpcClient = getRuntimeTrpcClient(currentProjectId);
				void trpcClient.workspace.generateDisplaySummary.mutate({ taskId, staleAfterSeconds }).catch(() => {
					// Best-effort — no toast for background summary generation.
				});
			}, HOVER_DEBOUNCE_MS);
		},
		[autoGenerateSummary, llmConfigured, currentProjectId, staleAfterSeconds],
	);
}
