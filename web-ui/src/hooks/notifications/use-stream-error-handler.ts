import { useCallback } from "react";
import { notifyError, showAppToast } from "@/components/app-toaster";
import { parseRemovedProjectPathFromStreamError } from "@/hooks/project/project-navigation";

/** Handle each explicit runtime error message, not changes to the last-error state.
 * Transport disconnections have their own persistent fallback and do not enter here.
 */
export function useStreamErrorHandler(): (message: string) => void {
	return useCallback((message: string) => {
		const removedPath = parseRemovedProjectPathFromStreamError(message);
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
			return;
		}
		notifyError(message);
	}, []);
}
