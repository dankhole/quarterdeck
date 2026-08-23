import type { IncomingMessage, ServerResponse } from "node:http";

import { diagnosticContextSchema, diagnosticRecordingScopeSchema } from "../core";
import { getDiagnosticErrorClass, sanitizeDiagnosticText } from "./bounded-value";
import type { DiagnosticRecordFilter } from "./diagnostic-record";
import type { RuntimeDiagnostics } from "./runtime-diagnostics";

const DIAGNOSTIC_TOKEN_HEADER = "x-quarterdeck-diagnostic-token";
const BROWSER_CAPABILITY_HEADER = "x-quarterdeck-diagnostic-capability";
const CLIENT_ID_HEADER = "x-quarterdeck-client-id";
const MAX_REQUEST_BODY_BYTES = 1024 * 1024;

function headerValue(request: IncomingMessage, name: string): string | undefined {
	const value = request.headers[name];
	return Array.isArray(value) ? value[0] : value;
}

function sendJson(response: ServerResponse, status: number, payload: unknown): void {
	response.writeHead(status, {
		"Cache-Control": "no-store",
		"Content-Type": "application/json; charset=utf-8",
	});
	response.end(JSON.stringify(payload));
}

async function readJsonBody(request: IncomingMessage): Promise<unknown> {
	const chunks: Buffer[] = [];
	let size = 0;
	for await (const chunk of request) {
		const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
		size += buffer.length;
		if (size > MAX_REQUEST_BODY_BYTES) throw new Error("Diagnostic request body is too large.");
		chunks.push(buffer);
	}
	if (chunks.length === 0) return {};
	return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
}

function isObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseFilter(url: URL): DiagnosticRecordFilter {
	const filter: DiagnosticRecordFilter = {};
	const setString = (key: keyof DiagnosticRecordFilter, parameter: string): void => {
		const value = url.searchParams.get(parameter)?.trim();
		if (value) Object.assign(filter, { [key]: value });
	};
	setString("projectId", "projectId");
	setString("taskId", "taskId");
	setString("sessionInstanceId", "sessionInstanceId");
	setString("operationId", "operationId");
	setString("name", "name");
	const afterSequence = Number.parseInt(url.searchParams.get("afterSequence") ?? "", 10);
	if (Number.isFinite(afterSequence) && afterSequence >= 0) filter.afterSequence = afterSequence;
	const since = Number.parseInt(url.searchParams.get("since") ?? "", 10);
	if (Number.isFinite(since) && since >= 0) filter.since = since;
	const until = Number.parseInt(url.searchParams.get("until") ?? "", 10);
	if (Number.isFinite(until) && until >= 0) filter.until = until;
	const source = url.searchParams.get("source");
	if (source === "runtime" || source === "browser" || source === "agent-lab") filter.source = source;
	const level = url.searchParams.get("level");
	if (level === "debug" || level === "info" || level === "warn" || level === "error") filter.level = level;
	return filter;
}

function authenticateRuntime(request: IncomingMessage, diagnostics: RuntimeDiagnostics): boolean {
	return diagnostics.verifyDiagnosticToken(headerValue(request, DIAGNOSTIC_TOKEN_HEADER));
}

function authenticateBrowser(request: IncomingMessage, diagnostics: RuntimeDiagnostics): string | null {
	const clientId = headerValue(request, CLIENT_ID_HEADER)?.trim();
	if (!clientId) return null;
	return diagnostics.verifyBrowserCapability(headerValue(request, BROWSER_CAPABILITY_HEADER), clientId);
}

export async function handleDiagnosticsHttpRequest(
	request: IncomingMessage,
	response: ServerResponse,
	url: URL,
	diagnostics: RuntimeDiagnostics,
): Promise<boolean> {
	if (!url.pathname.startsWith("/api/diagnostics/")) return false;

	try {
		if (url.pathname === "/api/diagnostics/browser-records" && request.method === "POST") {
			const clientId = authenticateBrowser(request, diagnostics);
			if (!clientId) {
				sendJson(response, 403, { error: "Diagnostic capability rejected." });
				return true;
			}
			const body = await readJsonBody(request);
			if (!isObject(body) || !Array.isArray(body.records) || body.records.length > 100) {
				sendJson(response, 400, { error: "Invalid browser diagnostic batch." });
				return true;
			}
			sendJson(response, 200, diagnostics.ingestBrowserRecords(clientId, body.records));
			return true;
		}

		if (url.pathname === "/api/diagnostics/browser-snapshot" && request.method === "POST") {
			const clientId = authenticateBrowser(request, diagnostics);
			if (!clientId) {
				sendJson(response, 403, { error: "Diagnostic capability rejected." });
				return true;
			}
			const body = await readJsonBody(request);
			if (!isObject(body) || typeof body.nonce !== "string" || !("snapshot" in body)) {
				sendJson(response, 400, { error: "Invalid browser diagnostic snapshot." });
				return true;
			}
			diagnostics.ingestBrowserSnapshot(clientId, body.nonce, body.snapshot);
			sendJson(response, 200, { ok: true });
			return true;
		}

		if (url.pathname === "/api/diagnostics/browser-export" && request.method === "POST") {
			const clientId = authenticateBrowser(request, diagnostics);
			if (!clientId) {
				sendJson(response, 403, { error: "Diagnostic capability rejected." });
				return true;
			}
			const result = await diagnostics.writeBundle({ requestBrowser: true });
			sendJson(response, 200, { path: result.path, manifest: result.manifest });
			return true;
		}

		if (url.pathname === "/api/diagnostics/browser-status" && request.method === "GET") {
			const clientId = authenticateBrowser(request, diagnostics);
			if (!clientId) {
				sendJson(response, 403, { error: "Diagnostic capability rejected." });
				return true;
			}
			const data = await diagnostics.collectCaptureData();
			sendJson(response, 200, {
				descriptor: data.descriptor,
				health: data.health,
				records: diagnostics.getBrowserTimelineRecords(),
				snapshot: data.snapshot,
				findings: data.findings,
				warnings: data.warnings,
			});
			return true;
		}

		if (url.pathname === "/api/diagnostics/browser-subscription" && request.method === "POST") {
			const clientId = authenticateBrowser(request, diagnostics);
			const capability = headerValue(request, BROWSER_CAPABILITY_HEADER);
			if (!clientId || !capability) {
				sendJson(response, 403, { error: "Diagnostic capability rejected." });
				return true;
			}
			const body = await readJsonBody(request);
			if (
				!isObject(body) ||
				typeof body.subscribed !== "boolean" ||
				typeof body.revision !== "number" ||
				!Number.isSafeInteger(body.revision) ||
				body.revision < 0
			) {
				sendJson(response, 400, { error: "Invalid browser diagnostic subscription." });
				return true;
			}
			const subscription = diagnostics.setBrowserLiveSubscription(
				clientId,
				capability,
				body.subscribed,
				body.revision,
			);
			sendJson(response, 200, {
				...subscription,
				records: subscription.subscribed ? diagnostics.getBrowserTimelineRecords() : [],
			});
			return true;
		}

		if (url.pathname === "/api/diagnostics/browser-record" && request.method === "POST") {
			const clientId = authenticateBrowser(request, diagnostics);
			if (!clientId) {
				sendJson(response, 403, { error: "Diagnostic capability rejected." });
				return true;
			}
			const body = await readJsonBody(request);
			if (!isObject(body) || (body.action !== "start" && body.action !== "stop")) {
				sendJson(response, 400, { error: "Invalid recording request." });
				return true;
			}
			if (body.action === "stop") {
				sendJson(response, 200, diagnostics.stopRecording());
				return true;
			}
			if (typeof body.durationMs !== "number") {
				sendJson(response, 400, { error: "Recording durationMs is required." });
				return true;
			}
			const scope = diagnosticRecordingScopeSchema.parse(body.scope ?? {});
			sendJson(response, 200, diagnostics.startRecording(body.durationMs, scope));
			return true;
		}

		if (!authenticateRuntime(request, diagnostics)) {
			sendJson(response, 403, { error: "Diagnostic authentication rejected." });
			return true;
		}

		if (url.pathname === "/api/diagnostics/status" && request.method === "GET") {
			sendJson(response, 200, {
				descriptor: diagnostics.instance.getPublicDescriptor(),
				health: diagnostics.recorder.getHealth(),
			});
			return true;
		}

		if (url.pathname === "/api/diagnostics/records" && request.method === "GET") {
			sendJson(response, 200, { records: diagnostics.getRecords(parseFilter(url)) });
			return true;
		}

		if (url.pathname === "/api/diagnostics/capture" && request.method === "POST") {
			const body = await readJsonBody(request);
			const requestBrowser = isObject(body) && body.requestBrowser === true;
			const data = await diagnostics.collectCaptureData({ filter: parseFilter(url), requestBrowser });
			sendJson(response, 200, data);
			return true;
		}

		if (url.pathname === "/api/diagnostics/doctor" && request.method === "POST") {
			const body = await readJsonBody(request);
			const requestBrowser = isObject(body) && body.requestBrowser === true;
			const data = await diagnostics.collectCaptureData({ filter: parseFilter(url), requestBrowser });
			sendJson(response, 200, { snapshot: data.snapshot, findings: data.findings, warnings: data.warnings });
			return true;
		}

		if (url.pathname === "/api/diagnostics/record" && request.method === "POST") {
			const body = await readJsonBody(request);
			if (!isObject(body) || (body.action !== "start" && body.action !== "stop")) {
				sendJson(response, 400, { error: "Invalid recording request." });
				return true;
			}
			if (body.action === "stop") {
				sendJson(response, 200, diagnostics.stopRecording());
				return true;
			}
			if (typeof body.durationMs !== "number") {
				sendJson(response, 400, { error: "Recording durationMs is required." });
				return true;
			}
			const scope = diagnosticRecordingScopeSchema.parse(body.scope ?? {});
			sendJson(response, 200, diagnostics.startRecording(body.durationMs, scope));
			return true;
		}

		if (url.pathname === "/api/diagnostics/mark" && request.method === "POST") {
			const body = await readJsonBody(request);
			if (!isObject(body) || typeof body.message !== "string") {
				sendJson(response, 400, { error: "Diagnostic mark message is required." });
				return true;
			}
			const context = diagnosticContextSchema.safeParse(body.context ?? {});
			const record = diagnostics.record({
				source: "runtime",
				kind: "mark",
				level: "info",
				name: "diagnostics.mark",
				context: context.success ? context.data : {},
				payload: { message: body.message },
				essential: true,
			});
			sendJson(response, 200, { record });
			return true;
		}

		sendJson(response, 404, { error: "Diagnostic endpoint not found." });
		return true;
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		const sanitizedMessage = sanitizeDiagnosticText(message).value;
		diagnostics.recordEvent(
			"diagnostics.request_failed",
			{ errorClass: getDiagnosticErrorClass(error) },
			{},
			{
				level: "warn",
				essential: true,
			},
		);
		sendJson(response, 400, { error: sanitizedMessage.slice(0, 2_048) });
		return true;
	}
}

export { BROWSER_CAPABILITY_HEADER, CLIENT_ID_HEADER, DIAGNOSTIC_TOKEN_HEADER };
