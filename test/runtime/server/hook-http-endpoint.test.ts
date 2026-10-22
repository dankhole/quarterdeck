import { once } from "node:events";
import { createServer, request as httpRequest, type IncomingHttpHeaders, type Server } from "node:http";
import type { AddressInfo } from "node:net";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { buildHookIngestRequest } from "../../../src/commands/hook-metadata";
import type { RuntimeHookIngestRequest, RuntimeHookIngestResponse } from "../../../src/core";
import {
	getQuarterdeckRuntimeHost,
	getQuarterdeckRuntimePort,
	setQuarterdeckRuntimeHost,
	setQuarterdeckRuntimePort,
} from "../../../src/core/runtime-endpoint";
import {
	createHookHttpEndpoint,
	HOOK_HTTP_MAX_BODY_BYTES,
	type HookHttpEndpoint,
	resolveHookHttpOrigin,
} from "../../../src/server/hook-http-endpoint";
import { handleHttpRequest } from "../../../src/server/middleware";
import {
	getActiveHookHttpChannel,
	HookHttpChannel,
	type HookHttpLaunch,
	setActiveHookHttpChannel,
} from "../../../src/terminal/hook-http-channel";

interface HttpResult {
	status: number;
	headers: IncomingHttpHeaders;
	body: string;
}

const identity = { taskId: "task-1", projectId: "project-1", sessionInstanceId: "instance-1" };
const subagentStopPayload = {
	session_id: "claude-session-1",
	transcript_path: "/Users/test/.claude/projects/p/claude-session-1.jsonl",
	cwd: "/tmp/worktree",
	permission_mode: "default",
	hook_event_name: "SubagentStop",
	stop_hook_active: false,
	agent_id: "agent-7",
	agent_type: "Explore",
	agent_transcript_path: "/Users/test/.claude/projects/p/subagents/agent-7.jsonl",
	last_assistant_message: "Found the three call sites.",
};

/** Resolves Claude's `${VAR}` header templates from a launch environment, as Claude does for allowlisted names. */
function interpolateHeaders(launch: HookHttpLaunch, env: Record<string, string | undefined>): Record<string, string> {
	return Object.fromEntries(
		Object.entries(launch.transport.headers).map(([name, template]) => [
			name,
			template.replace(/\$\{([A-Z0-9_]+)\}/g, (_, envName: string) =>
				launch.transport.allowedEnvVars.includes(envName) ? (env[envName] ?? "") : "",
			),
		]),
	);
}

describe("hook HTTP endpoint", () => {
	const originalHost = getQuarterdeckRuntimeHost();
	const originalPort = getQuarterdeckRuntimePort();
	let server: Server;
	let origin: string;
	let endpoint: HookHttpEndpoint;
	let ingest: ReturnType<typeof vi.fn<(request: RuntimeHookIngestRequest) => Promise<RuntimeHookIngestResponse>>>;
	let simulatedRemoteAddress: string | null;

	function launchHeaders(context = identity): Record<string, string> {
		const launch = endpoint.channel.prepareLaunch(context);
		if (!launch) throw new Error("Expected the hook endpoint to be published.");
		return {
			"content-type": "application/json",
			...interpolateHeaders(launch, {
				...launch.env,
				QUARTERDECK_HOOK_TASK_ID: context.taskId,
				QUARTERDECK_HOOK_PROJECT_ID: context.projectId,
				QUARTERDECK_HOOK_SESSION_INSTANCE_ID: context.sessionInstanceId,
			}),
		};
	}

	function send(
		path: string,
		options: { method?: string; headers?: Record<string, string>; body?: string | Buffer } = {},
	): Promise<HttpResult> {
		return new Promise((resolve, reject) => {
			let result: HttpResult | null = null;
			const request = httpRequest(
				`${origin}${path}`,
				{ method: options.method ?? "POST", headers: options.headers ?? {}, agent: false },
				(response) => {
					const chunks: Buffer[] = [];
					result = { status: response.statusCode ?? 0, headers: response.headers, body: "" };
					response.on("data", (chunk: Buffer) => chunks.push(chunk));
					response.on("end", () =>
						resolve({ ...(result as HttpResult), body: Buffer.concat(chunks).toString("utf8") }),
					);
				},
			);
			// A rejected upload may be reset after its response arrives.
			request.on("error", (error) => (result ? resolve(result) : reject(error)));
			request.end(options.body);
		});
	}

	const notifyPath = "/api/hooks/notify?event=activity&source=claude";

	beforeEach(async () => {
		simulatedRemoteAddress = null;
		ingest = vi.fn(async () => ({ ok: true }));
		endpoint = createHookHttpEndpoint({ ingest });
		server = createServer((req, res) => {
			if (simulatedRemoteAddress) {
				Object.defineProperty(req.socket, "remoteAddress", { value: simulatedRemoteAddress, configurable: true });
			}
			if (handleHttpRequest(req, res).end) return;
			const url = new URL(req.url ?? "/", "http://localhost");
			void endpoint.handle(req, res, url).then((handled) => {
				if (!handled) {
					res.writeHead(404);
					res.end("not hook");
				}
			});
		});
		server.listen(0, "127.0.0.1");
		await once(server, "listening");
		const { port } = server.address() as AddressInfo;
		setQuarterdeckRuntimeHost("127.0.0.1");
		setQuarterdeckRuntimePort(port);
		origin = `http://127.0.0.1:${port}`;
		expect(endpoint.publish(server.address() as AddressInfo)).toBe(true);
	});

	afterEach(async () => {
		endpoint.withdraw();
		setActiveHookHttpChannel(null);
		server.closeAllConnections();
		await new Promise<void>((resolve) => server.close(() => resolve()));
		setQuarterdeckRuntimeHost(originalHost);
		setQuarterdeckRuntimePort(originalPort);
	});

	it("answers an authenticated best-effort hook with an empty 204 and hands it to the shared ingest", async () => {
		const response = await send(notifyPath, {
			headers: launchHeaders(),
			body: JSON.stringify(subagentStopPayload),
		});

		expect(response.status).toBe(204);
		expect(response.body).toBe("");
		await vi.waitFor(() => expect(ingest).toHaveBeenCalledTimes(1));
		const received = ingest.mock.calls[0]?.[0];
		const expected = buildHookIngestRequest({
			event: "activity",
			identity,
			flagMetadata: { source: "claude" },
			payload: subagentStopPayload,
		});
		expect({ ...received, delivery: undefined }).toEqual({ ...expected, delivery: undefined });
		expect(received?.metadata).toMatchObject({
			source: "claude",
			hookEventName: "SubagentStop",
			sessionId: "claude-session-1",
			sessionInstanceId: "instance-1",
			providerAgentId: "agent-7",
		});
		expect(received?.delivery?.id).toMatch(/^[0-9a-f-]{36}$/);
	});

	it("responds without waiting for ingest to finish", async () => {
		let releaseIngest: () => void = () => {};
		ingest.mockImplementation(
			() =>
				new Promise<RuntimeHookIngestResponse>((resolve) => {
					releaseIngest = () => resolve({ ok: true });
				}),
		);

		const response = await send(notifyPath, { headers: launchHeaders(), body: JSON.stringify(subagentStopPayload) });

		expect(response.status).toBe(204);
		expect(ingest).toHaveBeenCalledTimes(1);
		releaseIngest();
	});

	it("still answers 204 when the shared ingest rejects the hook, like `hooks notify`", async () => {
		ingest.mockResolvedValue({ ok: false, error: "Task not found" });
		const response = await send(notifyPath, { headers: launchHeaders(), body: JSON.stringify(subagentStopPayload) });
		expect(response.status).toBe(204);
	});

	it.each([
		["a missing credential", (headers: Record<string, string>) => delete headers["x-quarterdeck-hook-token"]],
		["an empty credential", (headers: Record<string, string>) => (headers["x-quarterdeck-hook-token"] = "")],
		["a missing task identity", (headers: Record<string, string>) => delete headers["x-quarterdeck-hook-task-id"]],
		[
			"another task's identity",
			(headers: Record<string, string>) => (headers["x-quarterdeck-hook-task-id"] = "task-2"),
		],
		[
			"another launch of the same task",
			(headers: Record<string, string>) => (headers["x-quarterdeck-hook-session-instance-id"] = "instance-2"),
		],
	])("rejects %s with 401", async (_label, mutate) => {
		const headers = launchHeaders();
		mutate(headers);
		const response = await send(notifyPath, { headers, body: JSON.stringify(subagentStopPayload) });
		expect(response.status).toBe(401);
		expect(ingest).not.toHaveBeenCalled();
	});

	it("rejects a credential minted by another runtime process", async () => {
		const otherRuntime = new HookHttpChannel();
		const headers = { ...launchHeaders(), "x-quarterdeck-hook-token": otherRuntime.mintCredential(identity) };
		const response = await send(notifyPath, { headers, body: JSON.stringify(subagentStopPayload) });
		expect(response.status).toBe(401);
		expect(ingest).not.toHaveBeenCalled();
	});

	it("never accepts a credential or extra parameters in the URL", async () => {
		const credential = endpoint.channel.mintCredential(identity);
		const { "x-quarterdeck-hook-token": _token, ...headersWithoutToken } = launchHeaders();

		const inUrlOnly = await send(`${notifyPath}&token=${credential}`, {
			headers: headersWithoutToken,
			body: JSON.stringify(subagentStopPayload),
		});
		const inUrlAndHeader = await send(`${notifyPath}&token=${credential}`, {
			headers: launchHeaders(),
			body: JSON.stringify(subagentStopPayload),
		});

		expect(inUrlOnly.status).toBe(400);
		expect(inUrlAndHeader.status).toBe(400);
		expect(ingest).not.toHaveBeenCalled();
	});

	it("rejects requests from a non-loopback peer", async () => {
		simulatedRemoteAddress = "203.0.113.7";
		const response = await send(notifyPath, { headers: launchHeaders(), body: JSON.stringify(subagentStopPayload) });
		expect(response.status).toBe(403);
		expect(ingest).not.toHaveBeenCalled();
	});

	it("rejects browser-originated requests even from an allowed runtime origin", async () => {
		const response = await send(notifyPath, {
			headers: { ...launchHeaders(), origin },
			body: JSON.stringify(subagentStopPayload),
		});
		expect(response.status).toBe(403);
		expect(ingest).not.toHaveBeenCalled();
	});

	it("rejects an oversized payload whether declared or streamed", async () => {
		// Leave the upload open so the rejection is observed without racing a reset of unread bytes.
		const sendOpenUpload = (headers: Record<string, string>, chunk?: Buffer): Promise<number> =>
			new Promise((resolve, reject) => {
				const request = httpRequest(
					`${origin}${notifyPath}`,
					{ method: "POST", headers, agent: false },
					(response) => {
						resolve(response.statusCode ?? 0);
						response.resume();
						request.destroy();
					},
				);
				request.on("error", reject);
				if (chunk) request.write(chunk);
				else request.flushHeaders();
			});

		const declared = await sendOpenUpload({
			...launchHeaders(),
			"content-length": String(HOOK_HTTP_MAX_BODY_BYTES + 1),
		});
		const streamed = await sendOpenUpload(
			{ ...launchHeaders(), "transfer-encoding": "chunked" },
			Buffer.alloc(HOOK_HTTP_MAX_BODY_BYTES + 1, 0x20),
		);

		expect(declared).toBe(413);
		expect(streamed).toBe(413);
		expect(ingest).not.toHaveBeenCalled();
	});

	it("rejects other methods, content types, and events", async () => {
		const get = await send(notifyPath, { method: "GET", headers: launchHeaders() });
		const text = await send(notifyPath, {
			headers: { ...launchHeaders(), "content-type": "text/plain" },
			body: JSON.stringify(subagentStopPayload),
		});
		const unknownEvent = await send("/api/hooks/notify?event=done&source=claude", {
			headers: launchHeaders(),
			body: JSON.stringify(subagentStopPayload),
		});
		const missingEvent = await send("/api/hooks/notify?source=claude", {
			headers: launchHeaders(),
			body: JSON.stringify(subagentStopPayload),
		});

		expect(get.status).toBe(405);
		expect(get.headers.allow).toBe("POST");
		expect(text.status).toBe(415);
		expect(unknownEvent.status).toBe(400);
		expect(missingEvent.status).toBe(400);
		expect(ingest).not.toHaveBeenCalled();
	});

	it.each(["to_review", "to_in_progress"])(
		"refuses the %s state transition, which requires the durable CLI outbox",
		async (event) => {
			const response = await send(`/api/hooks/notify?event=${event}&source=claude`, {
				headers: launchHeaders(),
				body: JSON.stringify({ ...subagentStopPayload, hook_event_name: "Stop" }),
			});
			expect(response.status).toBe(400);
			expect(ingest).not.toHaveBeenCalled();
		},
	);

	it("sheds load instead of queueing unbounded best-effort ingests", async () => {
		const saturated = createHookHttpEndpoint({
			channel: endpoint.channel,
			ingest: () => new Promise<RuntimeHookIngestResponse>(() => {}),
			maxInFlight: 1,
		});
		endpoint = saturated;

		const first = await send(notifyPath, { headers: launchHeaders(), body: JSON.stringify(subagentStopPayload) });
		const second = await send(notifyPath, { headers: launchHeaders(), body: JSON.stringify(subagentStopPayload) });

		expect(first.status).toBe(204);
		expect(second.status).toBe(503);
	});

	it("leaves other routes to their handlers", async () => {
		const response = await send("/api/hooks/other", { headers: launchHeaders(), body: "{}" });
		expect(response.status).toBe(404);
		expect(response.body).toBe("not hook");
	});
});

describe("hook HTTP endpoint publication", () => {
	afterEach(() => {
		setActiveHookHttpChannel(null);
	});

	it("maps bound loopback and wildcard addresses to a bracketed loopback origin and refuses interface binds", () => {
		const origin = (address: string) => resolveHookHttpOrigin({ address, port: 3500 });
		expect(origin("127.0.0.1")).toBe("http://127.0.0.1:3500");
		expect(origin("::ffff:127.0.0.1")).toBe("http://127.0.0.1:3500");
		expect(origin("0.0.0.0")).toBe("http://127.0.0.1:3500");
		expect(origin("::")).toBe("http://[::1]:3500");
		expect(origin("::1")).toBe("http://[::1]:3500");
		// server.address() reports literals; a host name is never trusted to pick the family.
		expect(origin("localhost")).toBeNull();
		expect(origin("192.168.1.20")).toBeNull();
		expect(origin("fe80::1")).toBeNull();
	});

	it("publishes the active channel for launches and withdraws it on shutdown", () => {
		const endpoint = createHookHttpEndpoint({ ingest: async () => ({ ok: true }) });

		expect(endpoint.publish({ address: "192.168.1.20", port: 3500 })).toBe(false);
		expect(getActiveHookHttpChannel()).toBeNull();

		expect(endpoint.publish({ address: "127.0.0.1", port: 3500 })).toBe(true);
		expect(getActiveHookHttpChannel()).toBe(endpoint.channel);
		expect(endpoint.channel.getNotifyUrl()).toBe("http://127.0.0.1:3500/api/hooks/notify");

		endpoint.withdraw();
		expect(getActiveHookHttpChannel()).toBeNull();
		expect(endpoint.channel.prepareLaunch(identity)).toBeNull();
	});

	it("does not clear a newer runtime's channel when an older endpoint withdraws", () => {
		const older = createHookHttpEndpoint({ ingest: async () => ({ ok: true }) });
		const newer = createHookHttpEndpoint({ ingest: async () => ({ ok: true }) });
		older.publish({ address: "127.0.0.1", port: 3500 });
		newer.publish({ address: "127.0.0.1", port: 3501 });

		older.withdraw();

		expect(getActiveHookHttpChannel()).toBe(newer.channel);
	});
});
