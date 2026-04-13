import { useEffect, useRef } from "react";
import { notifyError, showAppToast } from "@/components/app-toaster";
import { parseRemovedProjectPathFromStreamError } from "@/hooks/use-project-navigation";

interface UseStreamErrorHandlerInput {
	streamError: string | null;
	isRuntimeDisconnected: boolean;
}

/**
 * Handles stream errors from the runtime state stream by showing appropriate
 * toast notifications (removed project, disconnection, or generic error).
 */
export function useStreamErrorHandler({ streamError, isRuntimeDisconnected }: UseStreamErrorHandlerInput): void {
	const lastStreamErrorRef = useRef<string | null>(null);

	useEffect(() => {
		if (!streamError) {
			lastStreamErrorRef.current = null;
			return;
		}
		const removedPath = parseRemovedProjectPathFromStreamError(streamError);
		if (removedPath !== null) {
			showAppToast(
				{
					intent: "danger",
					icon: "warning-sign",
					message: removedPath
						? `Project no longer exists and was removed: ${removedPath}`
						: "Project no longer exists and was removed.",
					timeout: 6000,
				},
				`project-removed-${removedPath || "unknown"}`,
			);
			lastStreamErrorRef.current = null;
			return;
		}
		if (isRuntimeDisconnected) {
			lastStreamErrorRef.current = streamError;
			return;
		}
		if (lastStreamErrorRef.current !== streamError) {
			notifyError(streamError, { key: `error:${streamError}` });
		}
		lastStreamErrorRef.current = streamError;
	}, [isRuntimeDisconnected, streamError]);
}
