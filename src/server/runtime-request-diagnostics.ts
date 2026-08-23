import { randomUUID } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";

import type { DiagnosticContext } from "../core";
import type { RuntimeDiagnostics } from "../diagnostics";

const SLOW_API_REQUEST_MS = 2_000;

function firstHeader(request: IncomingMessage, name: string): string | undefined {
	const value = request.headers[name];
	return (Array.isArray(value) ? value[0] : value)?.trim().slice(0, 256) || undefined;
}

export function observeRuntimeApiRequest(
	request: IncomingMessage,
	response: ServerResponse,
	pathname: string,
	diagnostics: RuntimeDiagnostics,
): void {
	if (!pathname.startsWith("/api/")) return;
	const startedAt = performance.now();
	const context: DiagnosticContext = {
		requestId: randomUUID(),
		projectId: firstHeader(request, "x-quarterdeck-project-id"),
		clientId: firstHeader(request, "x-quarterdeck-client-id"),
	};
	let observed = false;
	const observe = (completion: "finished" | "closed"): void => {
		if (observed) return;
		observed = true;
		const durationMs = Math.round((performance.now() - startedAt) * 100) / 100;
		const failed = response.statusCode >= 400 || completion === "closed";
		const slow = durationMs >= SLOW_API_REQUEST_MS;
		diagnostics.recordEvent(
			failed ? "http.request_failed" : slow ? "http.request_slow" : "http.request_completed",
			{
				method: request.method ?? "UNKNOWN",
				pathname: pathname.slice(0, 256),
				statusCode: response.statusCode,
				durationMs,
				completion,
			},
			context,
			{
				level: failed || slow ? "warn" : "info",
				essential: failed || slow,
			},
		);
	};
	response.once("finish", () => observe("finished"));
	response.once("close", () => observe("closed"));
}
