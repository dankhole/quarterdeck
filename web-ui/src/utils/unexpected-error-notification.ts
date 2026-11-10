import { notifyError } from "@/components/app-toaster";
import { isRuntimeDisconnected } from "@/runtime/runtime-connection-state";

const NOTIFICATION_INTERVAL_MS = 10_000;

/** Last-resort feedback for otherwise unhandled failures, not a log-to-toast bridge. */
export function createUnexpectedErrorNotifier(): (error: unknown) => void {
	let lastNotificationAt: number | null = null;
	return (error) => {
		// Cancellation is expected; connection failures already have a persistent fallback.
		if (
			((error instanceof Error || error instanceof DOMException) && error.name === "AbortError") ||
			isRuntimeDisconnected()
		)
			return;
		const now = Date.now();
		if (lastNotificationAt !== null && now - lastNotificationAt < NOTIFICATION_INTERVAL_MS) return;
		lastNotificationAt = now;
		// Never render arbitrary exception text: it can contain prompts, paths, or credentials.
		notifyError(
			"An unexpected error interrupted Quarterdeck. Try the action again. If it keeps failing, open Diagnostics.",
			{ key: "unexpected-ui-error" },
		);
	};
}
