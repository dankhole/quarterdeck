export const DESKTOP_PRODUCTION_FEED_BASE = "https://update.electronjs.org/dankhole/quarterdeck/";

/** This base is build-time signed policy, never an endpoint accepted from renderer or runtime environment. */
export function canonicalDesktopValidationFeedBase(value: unknown): string | null {
	if (typeof value !== "string" || value.length > 2048 || !value.startsWith("https://") || /[\s?#]/u.test(value))
		return null;
	try {
		const url = new URL(value);
		if (url.protocol !== "https:" || !url.hostname || url.username || url.password || url.search || url.hash)
			return null;
		if (url.hostname.replace(/\.+$/u, "") === "update.electronjs.org") return null;
		const canonical = url.href.replace(/\/+$/u, "");
		if (value.replace(/\/+$/u, "") !== canonical) return null;
		return `${canonical}/`;
	} catch {
		return null;
	}
}
