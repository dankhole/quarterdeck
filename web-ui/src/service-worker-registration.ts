/** Browser navigation fallback is best effort; the desktop origin never installs a service worker. */
export async function registerBrowserServiceWorker(): Promise<void> {
	if (
		(window.location.protocol !== "http:" && window.location.protocol !== "https:") ||
		!("serviceWorker" in navigator)
	)
		return;
	try {
		await navigator.serviceWorker.register("/sw.js");
	} catch {
		// Registration can fail offline or under browser policy; ordinary app startup still proceeds.
	}
}
