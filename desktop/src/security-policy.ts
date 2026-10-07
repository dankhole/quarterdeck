import { createHash } from "node:crypto";

export const DESKTOP_ORIGIN = "app://quarterdeck";
export const DESKTOP_TOKEN_HEADER = "X-Quarterdeck-Desktop-Token";
export const DESKTOP_WEBSOCKET_PATHS = new Set(["/api/runtime/ws", "/api/terminal/io", "/api/terminal/control"]);

export function runtimeOrigin(value: string): string {
	const match = /^http:\/\/127\.0\.0\.1:([1-9]\d{0,4})$/.exec(value);
	if (!match || Number(match[1]) > 65_535) throw new Error("Invalid desktop runtime endpoint.");
	return value;
}

export function desktopUrl(value: string): URL | null {
	try {
		const url = new URL(value);
		return url.protocol === "app:" && url.host === "quarterdeck" && !url.username && !url.password ? url : null;
	} catch {
		return null;
	}
}

export function isProductPage(value: string): boolean {
	const url = desktopUrl(value);
	return url !== null && !url.pathname.startsWith("/__desktop/");
}

export function isPermittedHttpPath(pathname: string, method: string): boolean {
	let decoded: string;
	try {
		decoded = decodeURIComponent(pathname);
	} catch {
		return false;
	}
	if (
		/[\\?#]/.test(decoded) ||
		decoded.includes("\0") ||
		decoded.split("/").some((part) => part === "." || part === "..")
	)
		return false;
	if (decoded === "/api/trpc" || decoded.startsWith("/api/trpc/")) {
		const procedures = decoded.slice("/api/trpc/".length).split(",");
		return (
			procedures.every((procedure) => /^(runtime|project|projects)\.[a-zA-Z][a-zA-Z0-9.]*$/.test(procedure)) &&
			(method === "GET" || method === "POST" || method === "HEAD")
		);
	}
	if (decoded === "/api/diagnostics/browser-status") return method === "GET";
	if (
		[
			"/api/diagnostics/browser-records",
			"/api/diagnostics/browser-snapshot",
			"/api/diagnostics/browser-subscription",
			"/api/diagnostics/browser-export",
			"/api/diagnostics/browser-record",
		].includes(decoded)
	)
		return method === "POST";
	if (decoded.startsWith("/api/") || decoded.startsWith("/__desktop/")) return false;
	return method === "GET" || method === "HEAD";
}

export function isPinnedWebSocket(value: string, origin: string): boolean {
	try {
		const url = new URL(value);
		return (
			url.protocol === "ws:" &&
			`http://${url.host}` === runtimeOrigin(origin) &&
			!url.username &&
			!url.password &&
			!url.hash &&
			!url.searchParams.has("notificationPresentation") &&
			!url.searchParams.has("notificationOnly") &&
			DESKTOP_WEBSOCKET_PATHS.has(url.pathname)
		);
	} catch {
		return false;
	}
}

export function desktopPartition(canonicalStateHome: string): string {
	return `persist:quarterdeck-${createHash("sha256").update(canonicalStateHome).digest("hex")}`;
}

export function externalWebUrl(value: string): string | null {
	try {
		const url = new URL(value);
		return (url.protocol === "https:" || url.protocol === "http:") && !url.username && !url.password
			? url.toString()
			: null;
	} catch {
		return null;
	}
}

export function desktopCsp(origin: string | null): string {
	const socketSource = origin ? runtimeOrigin(origin).replace("http:", "ws:") : "";
	return [
		"default-src 'none'",
		"script-src 'self'",
		"style-src 'self' 'unsafe-inline'",
		"img-src 'self' data: blob:",
		"font-src 'self' data:",
		`connect-src 'self' ${socketSource}`.trim(),
		"worker-src 'self' blob:",
		"media-src 'self' blob:",
		"object-src 'none'",
		"frame-src 'none'",
		"base-uri 'none'",
		"form-action 'none'",
		"frame-ancestors 'none'",
	].join("; ");
}
