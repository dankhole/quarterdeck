import { useCallback, useEffect, useRef, useState } from "react";
import { flushSync } from "react-dom";

const LOCK_NAME = "quarterdeck-active-tab";
const CHANNEL_NAME = "quarterdeck-single-tab";

export function useSingleTabGuard(): { isBlocked: boolean; forceOpen: () => void } {
	// Never mount the runtime/terminal tree before the browser grants ownership.
	const [isBlocked, setIsBlocked] = useState(true);
	const [error, setError] = useState<Error | null>(null);
	const channelRef = useRef<BroadcastChannel | null>(null);

	const forceOpen = useCallback(() => {
		// Our request is already queued. Other tabs move behind it, releasing
		// ownership only after their app tree has unmounted. Never steal a lock.
		channelRef.current?.postMessage({ type: "yield" });
	}, []);

	useEffect(() => {
		if (!navigator.locks || typeof BroadcastChannel === "undefined") {
			setError(
				new Error(
					"This browser cannot coordinate Quarterdeck tabs. Use an up-to-date browser on localhost or HTTPS.",
				),
			);
			return;
		}

		let disposed = false;
		let request: AbortController | null = null;
		let release: (() => void) | null = null;
		let channel: BroadcastChannel | null = null;

		const cancelRequest = () => {
			request?.abort();
			request = null;
			release?.();
			release = null;
		};

		const queueRequest = () => {
			const controller = new AbortController();
			request = controller;
			void navigator.locks
				.request(LOCK_NAME, { signal: controller.signal }, async () => {
					if (disposed || controller.signal.aborted) return;
					await new Promise<void>((resolve) => {
						release = resolve;
						setIsBlocked(false);
					});
				})
				.catch(() => {
					if (!disposed && !controller.signal.aborted) {
						setError(
							new Error("Quarterdeck could not acquire exclusive tab access. Reload the page to try again."),
						);
					}
				});
		};

		const start = () => {
			channel = new BroadcastChannel(CHANNEL_NAME);
			channelRef.current = channel;
			channel.onmessage = (event: MessageEvent<unknown>) => {
				if (
					typeof event.data !== "object" ||
					event.data === null ||
					!("type" in event.data) ||
					event.data.type !== "yield"
				)
					return;
				// Commit teardown before releasing the lock to the next tab.
				flushSync(() => setIsBlocked(true));
				cancelRequest();
				queueRequest();
			};
			queueRequest();
		};

		const stop = () => {
			channel?.close();
			channel = null;
			channelRef.current = null;
			cancelRequest();
		};

		const onPageHide = () => {
			flushSync(() => setIsBlocked(true));
			stop();
		};
		const onPageShow = () => {
			if (!channel) start();
		};

		start();
		window.addEventListener("pagehide", onPageHide);
		window.addEventListener("pageshow", onPageShow);
		return () => {
			disposed = true;
			stop();
			window.removeEventListener("pagehide", onPageHide);
			window.removeEventListener("pageshow", onPageShow);
		};
	}, []);

	if (error) throw error;
	return { isBlocked, forceOpen };
}
