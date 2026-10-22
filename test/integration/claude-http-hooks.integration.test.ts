import { spawn } from "node:child_process";
import { once } from "node:events";
import { readFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";

import { createHTTPHandler } from "@trpc/server/adapters/standalone";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { ClaudeHookHandler, ClaudeHooksSettings } from "../../src/claude-hooks";
import type { RuntimeHookIngestRequest, RuntimeHookIngestResponse } from "../../src/core";
import {
	getQuarterdeckRuntimeHost,
	getQuarterdeckRuntimePort,
	setQuarterdeckRuntimeHost,
	setQuarterdeckRuntimePort,
} from "../../src/core/runtime-endpoint";
import { createHookHttpEndpoint } from "../../src/server/hook-http-endpoint";
import { handleHttpRequest } from "../../src/server/middleware";
import { prepareAgentLaunch } from "../../src/terminal";
import { setActiveHookHttpChannel } from "../../src/terminal/hook-http-channel";
import { runtimeAppRouter } from "../../src/trpc/app-router";
import type { RuntimeTrpcContext } from "../../src/trpc/app-router-context";
import { createGitTestEnv } from "../utilities/git-env";
import { resolveIntegrationNodeArgs } from "../utilities/integration-server";
import { createTempDir } from "../utilities/temp-dir";

const subagentStopPayload = {
	session_id: "claude-session-1",
	transcript_path: "/Users/test/.claude/projects/p/claude-session-1.jsonl",
	cwd: "/tmp/worktree",
	permission_mode: "default",
	hook_event_name: "SubagentStart",
	stop_hook_active: false,
	agent_id: "agent-7",
	agent_type: "Explore",
	agent_transcript_path: "/Users/test/.claude/projects/p/subagents/agent-7.jsonl",
	last_assistant_message: "Found the three call sites.",
};

function withoutDeliveryIdentity(request: RuntimeHookIngestRequest | undefined): unknown {
	return { ...request, delivery: request?.delivery ? "present" : "missing" };
}

describe("Claude HTTP hooks", () => {
	const originalHost = getQuarterdeckRuntimeHost();
	const originalPort = getQuarterdeckRuntimePort();
	const cleanups: Array<() => Promise<void> | void> = [];

	afterEach(async () => {
		for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
		setActiveHookHttpChannel(null);
		setQuarterdeckRuntimeHost(originalHost);
		setQuarterdeckRuntimePort(originalPort);
		vi.unstubAllEnvs();
	});

	it("delivers an HTTP-posted SubagentStart to the same ingest, with the same request, as `hooks notify`", async () => {
		const sandbox = createTempDir("quarterdeck-claude-http-hooks-");
		cleanups.push(() => sandbox.cleanupAsync());
		const stateHome = join(sandbox.path, "state");
		vi.stubEnv("QUARTERDECK_STATE_HOME", stateHome);

		// The runtime composition: the tRPC `hooks.ingest` procedure and the HTTP
		// endpoint both call one guarded hooksApi.ingest.
		const ingest = vi.fn(
			async (_request: RuntimeHookIngestRequest): Promise<RuntimeHookIngestResponse> => ({ ok: true }),
		);
		const hooksApi: RuntimeTrpcContext["hooksApi"] = { ingest };
		const trpcHandler = createHTTPHandler({
			basePath: "/api/trpc/",
			router: runtimeAppRouter,
			createContext: async () => ({ hooksApi }) as RuntimeTrpcContext,
		});
		const endpoint = createHookHttpEndpoint({ ingest: hooksApi.ingest });
		const server: Server = createServer((req, res) => {
			if (handleHttpRequest(req, res).end) return;
			const url = new URL(req.url ?? "/", "http://localhost");
			void endpoint.handle(req, res, url).then(async (handled) => {
				if (handled) return;
				if (url.pathname.startsWith("/api/trpc/")) {
					await trpcHandler(req, res);
					return;
				}
				res.writeHead(404);
				res.end();
			});
		});
		server.listen(0, "127.0.0.1");
		await once(server, "listening");
		cleanups.push(async () => {
			server.closeAllConnections();
			await new Promise<void>((resolve) => server.close(() => resolve()));
		});
		const { port } = server.address() as AddressInfo;
		setQuarterdeckRuntimeHost("127.0.0.1");
		setQuarterdeckRuntimePort(port);
		expect(endpoint.publish(server.address() as AddressInfo)).toBe(true);

		const launch = await prepareAgentLaunch({
			taskId: "task-1",
			agentId: "claude",
			binary: "claude",
			args: [],
			cwd: sandbox.path,
			prompt: "",
			projectId: "project-1",
			hookSessionInstanceId: "instance-1",
		});
		const settingsPath = launch.args[launch.args.indexOf("--settings") + 1] ?? "";
		const settings = JSON.parse(readFileSync(settingsPath, "utf8")) as ClaudeHooksSettings<ClaudeHookHandler>;
		const hook = settings.hooks.SubagentStart[0]?.hooks[0];
		if (hook?.type !== "http") throw new Error("Expected an HTTP SubagentStart hook.");

		// Claude: interpolate only allowlisted launch env into header templates, then POST the hook input.
		const headers = Object.fromEntries(
			Object.entries(hook.headers).map(([name, template]) => [
				name,
				template.replace(/\$\{([A-Z0-9_]+)\}/g, (_, envName: string) =>
					hook.allowedEnvVars.includes(envName) ? (launch.env[envName] ?? "") : "",
				),
			]),
		);
		const httpResponse = await fetch(hook.url, {
			method: "POST",
			headers: { ...headers, "Content-Type": "application/json" },
			body: JSON.stringify(subagentStopPayload),
		});
		expect(httpResponse.status).toBe(204);
		expect(await httpResponse.text()).toBe("");
		await vi.waitFor(() => expect(ingest).toHaveBeenCalledTimes(1));

		// The command transport the same event used before: `hooks notify --event activity --source claude`.
		const hookEnv = Object.fromEntries(
			Object.entries(launch.env).filter(
				(entry): entry is [string, string] => entry[0].startsWith("QUARTERDECK_HOOK_") && entry[1] !== undefined,
			),
		);
		const child = spawn(
			process.execPath,
			[...resolveIntegrationNodeArgs("src/cli.ts"), "hooks", "notify", "--event", "activity", "--source", "claude"],
			{
				env: createGitTestEnv({
					HOME: sandbox.path,
					USERPROFILE: sandbox.path,
					QUARTERDECK_STATE_HOME: stateHome,
					QUARTERDECK_RUNTIME_HOST: "127.0.0.1",
					QUARTERDECK_RUNTIME_PORT: String(port),
					...hookEnv,
				}),
				stdio: ["pipe", "ignore", "pipe"],
			},
		);
		let stderr = "";
		child.stderr.on("data", (chunk: Buffer) => {
			stderr += chunk.toString();
		});
		const closed = once(child, "close");
		const killTimer = setTimeout(() => child.kill("SIGKILL"), 15_000);
		child.stdin.end(JSON.stringify(subagentStopPayload));
		const [code] = await closed;
		clearTimeout(killTimer);
		expect({ code, stderr }).toEqual({ code: 0, stderr: "" });
		await vi.waitFor(() => expect(ingest).toHaveBeenCalledTimes(2));

		const [viaHttp, viaCli] = ingest.mock.calls.map(([request]) => request);
		expect(withoutDeliveryIdentity(viaHttp)).toEqual(withoutDeliveryIdentity(viaCli));
		expect(viaHttp).toMatchObject({
			taskId: "task-1",
			projectId: "project-1",
			event: "activity",
			metadata: {
				source: "claude",
				hookEventName: "SubagentStart",
				sessionId: "claude-session-1",
				sessionInstanceId: "instance-1",
				providerAgentId: "agent-7",
			},
		});
		expect(viaHttp?.delivery?.id).not.toBe(viaCli?.delivery?.id);
	}, 30_000);
});
