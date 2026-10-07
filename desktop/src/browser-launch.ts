import { runtimeOrigin } from "./security-policy.js";

/** Management produces this one-use URL; renderers never supply destinations or receive its capability. */
export function admittedBrowserLaunch(value: string, selectedOrigin: string): string | null {
	try {
		const url = new URL(value);
		if (
			url.origin !== runtimeOrigin(selectedOrigin) ||
			url.username ||
			url.password ||
			url.hash ||
			url.pathname !== "/api/runtime/client-bootstrap"
		)
			return null;
		const keys = [...url.searchParams.keys()];
		if (
			keys.length !== 1 ||
			keys[0] !== "capability" ||
			!/^[a-zA-Z0-9_-]{43,128}$/u.test(url.searchParams.get("capability") ?? "")
		)
			return null;
		return url.href;
	} catch {
		return null;
	}
}
