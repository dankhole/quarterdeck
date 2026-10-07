import type { RuntimeSelection } from "./runtime-selection.js";
import {
	DESKTOP_ORIGIN,
	DESKTOP_TOKEN_HEADER,
	desktopCsp,
	desktopUrl,
	isPermittedHttpPath,
} from "./security-policy.js";

export type DesktopProtocolRequest = Request & { initiatorOrigin?: string };
export type FetchTransport = (input: string, init: RequestInit & { duplex?: "half" }) => Promise<Response>;

function rejected(status: number): Response {
	return new Response("Desktop request unavailable.", { status, headers: { "Content-Type": "text/plain" } });
}

/** Only HTTP UI routes are proxied. Management, hooks and CLI diagnostics stay outside the renderer. */
export async function proxyRuntimeRequest(
	request: DesktopProtocolRequest,
	selection: RuntimeSelection,
	transport: FetchTransport = fetch,
): Promise<Response> {
	const url = desktopUrl(request.url);
	if (!url || (request.initiatorOrigin !== undefined && request.initiatorOrigin !== DESKTOP_ORIGIN))
		return rejected(403);
	if (!isPermittedHttpPath(url.pathname, request.method)) return rejected(403);
	const selected = selection.get();
	if (!selected) return rejected(503);
	const headers = new Headers(request.headers);
	for (const key of [
		"authorization",
		"cookie",
		"host",
		"connection",
		"proxy-authorization",
		"referer",
		DESKTOP_TOKEN_HEADER,
	]) {
		headers.delete(key);
	}
	headers.set(DESKTOP_TOKEN_HEADER, selected.clientToken);
	headers.set("Origin", DESKTOP_ORIGIN);
	const target = `${selected.origin}${url.pathname}${url.search}`;
	try {
		const response = await transport(target, {
			method: request.method,
			headers,
			body: request.method === "GET" || request.method === "HEAD" ? undefined : request.body,
			duplex: "half",
			signal: AbortSignal.any([request.signal, selected.signal]),
			redirect: "manual",
		});
		if (selection.get() !== selected || selected.signal.aborted) {
			await response.body?.cancel();
			return rejected(503);
		}
		if (response.status >= 300 && response.status < 400 && response.status !== 304) {
			await response.body?.cancel();
			return rejected(502);
		}
		const responseHeaders = new Headers(response.headers);
		for (const key of ["set-cookie", "connection", "transfer-encoding", DESKTOP_TOKEN_HEADER])
			responseHeaders.delete(key);
		// Node fetch decodes these while retaining their original response headers.
		responseHeaders.delete("content-encoding");
		responseHeaders.delete("content-length");
		responseHeaders.set("X-Content-Type-Options", "nosniff");
		if (responseHeaders.get("content-type")?.includes("text/html")) {
			responseHeaders.set("Content-Security-Policy", desktopCsp(selected.origin));
			responseHeaders.set("Cache-Control", "no-store");
		}
		return new Response(response.body, {
			status: response.status,
			statusText: response.statusText,
			headers: responseHeaders,
		});
	} catch {
		return rejected(selected.signal.aborted || request.signal.aborted ? 503 : 502);
	}
}
