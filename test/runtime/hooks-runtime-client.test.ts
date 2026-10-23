import { mkdtemp, readdir, rm } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createHTTPHandler } from "@trpc/server/adapters/standalone";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RuntimeHookIngestRequest, RuntimeHookIngestResponse } from "../../src/core/api/task-session";
import { getQuarterdeckRuntimePort, setQuarterdeckRuntimePort } from "../../src/core/runtime-endpoint";
import { loadPendingHookTransitions } from "../../src/hook-transition-outbox";
import { runHooksIngest, runHooksNotify } from "../../src/hooks-runtime-client";
import { runtimeAppRouter } from "../../src/trpc/app-router";
import type { RuntimeTrpcContext } from "../../src/trpc/app-router-context";

/**
 * Proves the lightweight hook client's supported HTTP request matches the exact
 * wire format the real server accepts for `POST /api/trpc/hooks.ingest`: a
 * non-batched tRPC HTTP RPC call (raw JSON input body, `{ result: { data } }` /
 * `{ error }` response), handled by the same `createHTTPHandler` instance the
 * runtime server uses (see `src/server/runtime-server.ts`).
 */

const originalStateHome = process.env.QUARTERDECK_STATE_HOME;
const originalPort = getQuarterdeckRuntimePort();
let stateHome: string;
let server: Server;
let ingestMock: ReturnType<typeof vi.fn<(input: RuntimeHookIngestRequest) => Promise<RuntimeHookIngestResponse>>>;

async function startServer(): Promise<number> {
	ingestMock = vi.fn(async () => ({ ok: true }));
	const context = { hooksApi: { ingest: ingestMock } } as unknown as RuntimeTrpcContext;
	const handler = createHTTPHandler({
		router: runtimeAppRouter,
		basePath: "/api/trpc/",
		createContext: async () => context,
	});
	server = createServer(handler);
	await new Promise<void>((resolveStart) => server.listen(0, "127.0.0.1", resolveStart));
	const address = server.address();
	if (!address || typeof address === "string") {
		throw new Error("Expected an ephemeral TCP port.");
	}
	return address.port;
}

const originalStdinIsTty = process.stdin.isTTY;

beforeEach(async () => {
	stateHome = await mkdtemp(join(tmpdir(), "quarterdeck-hooks-client-"));
	process.env.QUARTERDECK_STATE_HOME = stateHome;
	vi.stubEnv("QUARTERDECK_HOOK_TASK_ID", "task-1");
	vi.stubEnv("QUARTERDECK_HOOK_PROJECT_ID", "project-1");
	vi.stubEnv("QUARTERDECK_HOOK_SESSION_INSTANCE_ID", undefined);
	// The real CLI reads stdin for a piped hook payload; a Claude/Codex parent
	// process closes that pipe. Vitest's own stdin never closes, so pretend it's
	// a TTY (as a real interactive/no-stdin invocation would report) to keep
	// readStdinText() from hanging forever on an unrelated, never-ending stream.
	Object.defineProperty(process.stdin, "isTTY", { configurable: true, value: true });
	setQuarterdeckRuntimePort(await startServer());
});

afterEach(async () => {
	setQuarterdeckRuntimePort(originalPort);
	Object.defineProperty(process.stdin, "isTTY", { configurable: true, value: originalStdinIsTty });
	if (originalStateHome === undefined) {
		delete process.env.QUARTERDECK_STATE_HOME;
	} else {
		process.env.QUARTERDECK_STATE_HOME = originalStateHome;
	}
	await rm(stateHome, { recursive: true, force: true });
	vi.unstubAllEnvs();
	vi.unstubAllGlobals();
	vi.restoreAllMocks();
	process.exitCode = 0;
	server.closeAllConnections();
	await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
});

describe("hooks-runtime-client wire format", () => {
	it("sends a request the real hooks.ingest router/handler accepts", async () => {
		await runHooksIngest("to_review", { source: "claude" }, undefined);

		expect(ingestMock).toHaveBeenCalledExactlyOnceWith(
			expect.objectContaining({
				taskId: "task-1",
				projectId: "project-1",
				event: "to_review",
			}),
		);
	});

	it("does not depend on fetch", async () => {
		vi.stubGlobal("fetch", () => {
			throw new Error("fetch must not run");
		});
		await runHooksIngest("to_review", { source: "claude" }, undefined);
		expect(ingestMock).toHaveBeenCalledOnce();
	});

	it("retries with the same delivery ID, preserving full live metadata and enqueue-before-send", async () => {
		vi.stubEnv("QUARTERDECK_HOOK_SESSION_INSTANCE_ID", "launch-1");
		vi.spyOn(process.stderr, "write").mockImplementation(() => true);
		const observedRecords: unknown[] = [];
		ingestMock.mockImplementation(async () => {
			observedRecords.push(await loadPendingHookTransitions());
			return observedRecords.length === 1 ? { ok: false, error: "not ready" } : { ok: true };
		});

		await runHooksIngest(
			"to_in_progress",
			{
				source: "claude",
				hookEventName: "PostToolUse",
				activityText: "live activity",
				toolInputSummary: "live summary",
			},
			undefined,
		);

		expect(ingestMock).toHaveBeenCalledTimes(2);
		const [first, second] = ingestMock.mock.calls.map(([input]) => input);
		expect(first?.delivery?.id).toBeTruthy();
		expect(second?.delivery).toEqual(first?.delivery);
		expect(first?.metadata).toMatchObject({ activityText: "live activity", toolInputSummary: "live summary" });
		for (const records of observedRecords) {
			expect(records).toEqual([
				expect.objectContaining({ request: expect.objectContaining({ delivery: first?.delivery }) }),
			]);
			expect(JSON.stringify(records)).not.toContain("live activity");
		}
		expect(await readdir(join(stateHome, "hook-transition-outbox"))).toEqual([]);
	});

	it("retains an abandoned record and succeeds when the runtime refuses connection", async () => {
		vi.stubEnv("QUARTERDECK_HOOK_SESSION_INSTANCE_ID", "launch-1");
		vi.spyOn(process.stderr, "write").mockImplementation(() => true);
		await new Promise<void>((resolve) => server.close(() => resolve()));

		await runHooksIngest("to_review", { source: "claude" }, undefined);

		expect(process.exitCode ?? 0).toBe(0);
		expect(await loadPendingHookTransitions()).toEqual([
			expect.objectContaining({ abandonedAt: expect.any(Number) }),
		]);
	});

	it.each([
		{
			status: 500,
			body: JSON.stringify({ result: { data: { ok: true } } }),
			diagnostic: "unsuccessful response (status 500)",
		},
		{
			status: 200,
			body: JSON.stringify({ result: { data: {} } }),
			diagnostic: "Unexpected hook ingest response shape",
		},
		{
			status: 200,
			body: JSON.stringify({ result: { data: { ok: "true" } } }),
			diagnostic: "Unexpected hook ingest response shape",
		},
		{ status: 503, body: "private shutdown body", diagnostic: "non-JSON response (status 503)" },
	])(
		"does not acknowledge a queued record for an invalid response: $status $diagnostic",
		async ({ status, body, diagnostic }) => {
			vi.stubEnv("QUARTERDECK_HOOK_SESSION_INSTANCE_ID", "launch-1");
			const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
			server.removeAllListeners("request");
			server.on("request", (req, res) => {
				req.resume();
				res.writeHead(status);
				res.end(body);
			});

			await runHooksIngest("to_review", { source: "claude" }, undefined);

			expect(process.exitCode ?? 0).toBe(0);
			expect(await loadPendingHookTransitions()).toEqual([
				expect.objectContaining({ abandonedAt: expect.any(Number) }),
			]);
			const diagnosticText = stderr.mock.calls.map(([chunk]) => String(chunk)).join("");
			expect(diagnosticText).toContain(diagnostic);
			expect(diagnosticText).not.toContain(body);
		},
	);

	it("delivers the same request shape for best-effort notify", async () => {
		await runHooksNotify("activity", { source: "claude" }, undefined);

		expect(ingestMock).toHaveBeenCalledExactlyOnceWith(
			expect.objectContaining({ taskId: "task-1", projectId: "project-1", event: "activity" }),
		);
	});

	it("surfaces the server's rejection reason and retries once before giving up", async () => {
		ingestMock.mockResolvedValue({ ok: false, error: "not ready" });
		const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);

		await runHooksIngest("to_review", { source: "claude" }, undefined);

		expect(ingestMock).toHaveBeenCalledTimes(2);
		expect(process.exitCode).toBe(1);
		process.exitCode = 0;
		stderr.mockRestore();
	});

	it("treats a real tRPC error envelope (handler throw) as a hook ingest failure after retrying", async () => {
		ingestMock.mockRejectedValue(new Error("boom"));
		const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);

		await runHooksIngest("to_review", { source: "claude" }, undefined);

		expect(ingestMock).toHaveBeenCalledTimes(2);
		expect(process.exitCode).toBe(1);
		expect(stderr.mock.calls.map(([chunk]) => String(chunk)).join("")).toContain("boom");
		process.exitCode = 0;
		stderr.mockRestore();
	});
});
