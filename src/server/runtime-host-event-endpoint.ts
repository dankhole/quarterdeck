import type { IncomingMessage, ServerResponse } from "node:http";

import { ZodError } from "zod";
import { runtimeBrowserHostIntegrationEventRequestSchema, runtimeHostIntegrationEventKindSchema } from "../core";
import type { RuntimeHostEventLedger } from "./runtime-host-event-ledger";

const HOST_EVENT_ENDPOINT = "/api/agent-lab/host-events";
const MAX_REQUEST_BYTES = 64 * 1024;
const MAX_WAIT_MS = 10_000;

function sendJson(res: ServerResponse, status: number, payload: unknown): void {
	res.writeHead(status, {
		"Cache-Control": "no-store",
		"Content-Type": "application/json; charset=utf-8",
	});
	res.end(JSON.stringify(payload));
}

async function readJsonBody(req: IncomingMessage): Promise<unknown> {
	const chunks: Buffer[] = [];
	let size = 0;
	for await (const chunk of req) {
		const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
		size += buffer.length;
		if (size > MAX_REQUEST_BYTES) {
			throw new Error("Host event request is too large.");
		}
		chunks.push(buffer);
	}
	return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
}

function parseBoundedInteger(value: string | null, fallback: number, maximum: number): number {
	if (!value || !/^\d+$/.test(value)) {
		return fallback;
	}
	return Math.min(Number.parseInt(value, 10), maximum);
}

export async function handleRuntimeHostEventRequest(
	req: IncomingMessage,
	res: ServerResponse,
	requestUrl: URL,
	ledger: RuntimeHostEventLedger,
): Promise<boolean> {
	if (
		requestUrl.pathname !== HOST_EVENT_ENDPOINT &&
		requestUrl.pathname !== `${HOST_EVENT_ENDPOINT}/flush` &&
		requestUrl.pathname !== `${HOST_EVENT_ENDPOINT}/reset`
	) {
		return false;
	}

	try {
		if (requestUrl.pathname === `${HOST_EVENT_ENDPOINT}/flush`) {
			if (req.method !== "POST") {
				sendJson(res, 405, { error: "Method not allowed." });
				return true;
			}
			const ledgerResponse = await ledger.flush();
			sendJson(res, 200, ledgerResponse);
			return true;
		}
		if (requestUrl.pathname === `${HOST_EVENT_ENDPOINT}/reset`) {
			if (req.method !== "POST") {
				sendJson(res, 405, { error: "Method not allowed." });
				return true;
			}
			await ledger.reset();
			sendJson(res, 200, { ok: true });
			return true;
		}
		if (req.method === "GET") {
			const afterSequence = parseBoundedInteger(
				requestUrl.searchParams.get("afterSequence"),
				0,
				Number.MAX_SAFE_INTEGER,
			);
			const timeoutMs = parseBoundedInteger(requestUrl.searchParams.get("timeoutMs"), 0, MAX_WAIT_MS);
			const rawKind = requestUrl.searchParams.get("kind");
			const kind = rawKind ? runtimeHostIntegrationEventKindSchema.parse(rawKind) : null;
			const response = await ledger.waitFor({ afterSequence, kind }, timeoutMs);
			sendJson(res, 200, response);
			return true;
		}
		if (req.method === "POST") {
			const request = runtimeBrowserHostIntegrationEventRequestSchema.parse(await readJsonBody(req));
			const event = await ledger.recordBrowserEvent(request);
			sendJson(res, 201, { event });
			return true;
		}
		sendJson(res, 405, { error: "Method not allowed." });
		return true;
	} catch (error) {
		sendJson(res, error instanceof ZodError ? 400 : 500, {
			error: error instanceof Error ? error.message : String(error),
		});
		return true;
	}
}
