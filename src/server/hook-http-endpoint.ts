import type { IncomingMessage, ServerResponse } from "node:http";

import { buildHookIngestRequest, parseJsonObject, parseMetadataFromOptions } from "../commands/hook-metadata";
import { type RuntimeHookIngestRequest, type RuntimeHookIngestResponse, runtimeHookIngestRequestSchema } from "../core";
import {
	getActiveHookHttpChannel,
	HOOK_HTTP_NOTIFY_PATH,
	HOOK_HTTP_PROJECT_ID_HEADER,
	HOOK_HTTP_SESSION_INSTANCE_ID_HEADER,
	HOOK_HTTP_TASK_ID_HEADER,
	HOOK_HTTP_TOKEN_HEADER,
	HookHttpChannel,
	type HookRuntimeContext,
	setActiveHookHttpChannel,
} from "../terminal";
import { isLoopbackAddress } from "./runtime-client-access";

/** Claude hook inputs are small JSON documents; a subagent's final message is the largest field. */
export const HOOK_HTTP_MAX_BODY_BYTES = 1024 * 1024;
/** Accepted best-effort ingests still running; beyond this the channel sheds load instead of queueing. */
export const HOOK_HTTP_MAX_IN_FLIGHT = 64;
const MAX_IDENTITY_LENGTH = 256;
const MAX_SOURCE_LENGTH = 64;
const QUERY_KEYS = new Set(["event", "source"]);

export interface HookHttpEndpointDependencies {
	/** The same guarded ingest the `hooks.ingest` tRPC procedure calls for `hooks notify`. */
	ingest: (request: RuntimeHookIngestRequest) => Promise<RuntimeHookIngestResponse>;
	channel?: HookHttpChannel;
	maxInFlight?: number;
}

export interface HookHttpEndpoint {
	readonly channel: HookHttpChannel;
	/** Returns true when the request targeted the hook endpoint and has been answered. */
	handle(request: IncomingMessage, response: ServerResponse, url: URL): Promise<boolean>;
	/** Publishes the loopback endpoint for new launches from the listener's actual bound address. */
	publish(boundAddress: HookHttpBoundAddress): boolean;
	/** Stops offering the endpoint to new launches; already-issued credentials still verify until exit. */
	withdraw(): void;
}

class HookHttpRequestError extends Error {
	constructor(
		readonly status: number,
		message: string,
	) {
		super(message);
	}
}

/** The listener's `server.address()`: a literal IP, never a configured host name. */
export interface HookHttpBoundAddress {
	address: string;
	port: number;
}

/**
 * Maps the listener's actual bound address to the loopback origin a local
 * provider should use, or null for an interface bind a loopback peer cannot
 * reach. Using the bound literal avoids resolving a configured name such as
 * `localhost` to the other address family.
 */
export function resolveHookHttpOrigin({ address, port }: HookHttpBoundAddress): string | null {
	const normalized = address.trim().toLowerCase();
	if (normalized === "127.0.0.1" || normalized === "0.0.0.0" || normalized === "::ffff:127.0.0.1") {
		return `http://127.0.0.1:${port}`;
	}
	if (normalized === "::1" || normalized === "::") return `http://[::1]:${port}`;
	return null;
}

function singleHeader(request: IncomingMessage, name: string): string | undefined {
	const value = request.headers[name];
	return typeof value === "string" ? value : undefined;
}

function readIdentityHeader(request: IncomingMessage, name: string): string | null {
	const value = singleHeader(request, name)?.trim();
	if (!value) return null;
	if (value.length > MAX_IDENTITY_LENGTH) throw new HookHttpRequestError(401, "Hook identity is invalid.");
	return value;
}

function readIdentity(request: IncomingMessage): HookRuntimeContext {
	const taskId = readIdentityHeader(request, HOOK_HTTP_TASK_ID_HEADER);
	const projectId = readIdentityHeader(request, HOOK_HTTP_PROJECT_ID_HEADER);
	if (!taskId || !projectId) throw new HookHttpRequestError(401, "Hook identity is required.");
	return { taskId, projectId, sessionInstanceId: readIdentityHeader(request, HOOK_HTTP_SESSION_INSTANCE_ID_HEADER) };
}

// Best-effort delivery carries only activity. State transitions (`to_review`,
// `to_in_progress`) require the CLI's durable outbox and are refused here.
function readQuery(url: URL): { event: "activity"; source: string | undefined } {
	const keys = [...url.searchParams.keys()];
	const events = url.searchParams.getAll("event");
	const sources = url.searchParams.getAll("source");
	const source = sources[0]?.trim();
	if (
		keys.some((key) => !QUERY_KEYS.has(key)) ||
		events.length !== 1 ||
		events[0] !== "activity" ||
		sources.length > 1 ||
		(source !== undefined && (source.length === 0 || source.length > MAX_SOURCE_LENGTH))
	) {
		throw new HookHttpRequestError(400, "Invalid hook event.");
	}
	return { event: "activity", source };
}

async function readBoundedBody(request: IncomingMessage): Promise<string> {
	const declaredLength = Number(singleHeader(request, "content-length"));
	if (Number.isFinite(declaredLength) && declaredLength > HOOK_HTTP_MAX_BODY_BYTES) {
		throw new HookHttpRequestError(413, "Hook payload is too large.");
	}
	const chunks: Buffer[] = [];
	let size = 0;
	for await (const chunk of request) {
		const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
		size += bytes.length;
		if (size > HOOK_HTTP_MAX_BODY_BYTES) throw new HookHttpRequestError(413, "Hook payload is too large.");
		chunks.push(bytes);
	}
	return Buffer.concat(chunks).toString("utf8");
}

function reject(response: ServerResponse, status: number, message: string): void {
	response.writeHead(status, {
		"Cache-Control": "no-store",
		"Content-Type": "application/json; charset=utf-8",
		...(status === 405 ? { Allow: "POST" } : undefined),
		// The unread remainder of a rejected body is discarded with the connection.
		...(status === 413 ? { Connection: "close" } : undefined),
	});
	response.end(JSON.stringify({ error: message }));
}

/**
 * Best-effort native hook ingest over loopback HTTP, equivalent to `hooks notify`.
 *
 * The request must come from a loopback peer without a browser Origin, carry a
 * credential minted for its exact task-session identity, and fit the payload
 * bound. Accepted hooks are answered immediately with an empty 204 and handed to
 * the shared ingest without waiting, so the provider never blocks on runtime
 * work. Ingest outcomes are not reported back: like `hooks notify`, delivery is
 * best effort and has no retry or durable outbox.
 */
export function createHookHttpEndpoint(deps: HookHttpEndpointDependencies): HookHttpEndpoint {
	const channel = deps.channel ?? new HookHttpChannel();
	const maxInFlight = deps.maxInFlight ?? HOOK_HTTP_MAX_IN_FLIGHT;
	let inFlight = 0;

	const admit = async (request: IncomingMessage, url: URL): Promise<RuntimeHookIngestRequest> => {
		if (request.method !== "POST") throw new HookHttpRequestError(405, "Method not allowed.");
		if (!isLoopbackAddress(request.socket.remoteAddress) || request.headers.origin !== undefined) {
			throw new HookHttpRequestError(403, "Hook delivery is only available to local providers.");
		}
		if (!singleHeader(request, "content-type")?.toLowerCase().startsWith("application/json")) {
			throw new HookHttpRequestError(415, "Expected JSON.");
		}
		const query = readQuery(url);
		const identity = readIdentity(request);
		if (!channel.verifyCredential(identity, singleHeader(request, HOOK_HTTP_TOKEN_HEADER))) {
			throw new HookHttpRequestError(401, "Hook credential is invalid.");
		}
		const payload = parseJsonObject((await readBoundedBody(request)).trim());
		const ingestRequest = runtimeHookIngestRequestSchema.safeParse(
			buildHookIngestRequest({
				event: query.event,
				identity,
				flagMetadata: parseMetadataFromOptions({ source: query.source }),
				payload,
			}),
		);
		if (!ingestRequest.success) throw new HookHttpRequestError(400, "Invalid hook payload.");
		return ingestRequest.data;
	};

	return {
		channel,
		handle: async (request, response, url) => {
			if (url.pathname !== HOOK_HTTP_NOTIFY_PATH) return false;
			let ingestRequest: RuntimeHookIngestRequest;
			try {
				ingestRequest = await admit(request, url);
			} catch (error) {
				if (error instanceof HookHttpRequestError) reject(response, error.status, error.message);
				else reject(response, 400, "Invalid hook request.");
				return true;
			}
			if (inFlight >= maxInFlight) {
				reject(response, 503, "Hook delivery is saturated.");
				return true;
			}
			inFlight += 1;
			void deps
				.ingest(ingestRequest)
				.catch(() => undefined)
				.finally(() => {
					inFlight -= 1;
				});
			response.writeHead(204, { "Cache-Control": "no-store" });
			response.end();
			return true;
		},
		publish: (boundAddress) => {
			const origin = resolveHookHttpOrigin(boundAddress);
			if (!origin) return false;
			channel.publishEndpoint(origin);
			setActiveHookHttpChannel(channel);
			return true;
		},
		withdraw: () => {
			channel.withdrawEndpoint();
			if (getActiveHookHttpChannel() === channel) setActiveHookHttpChannel(null);
		},
	};
}
