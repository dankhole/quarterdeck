import { spawnSync } from "node:child_process";
import { once } from "node:events";
import { readFileSync } from "node:fs";
import { mkdir, mkdtemp, readFile, realpath, rename, rm, symlink, writeFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
	HOOK_HTTP_PROJECT_ID_HEADER,
	HOOK_HTTP_SESSION_INSTANCE_ID_HEADER,
	HOOK_HTTP_TASK_ID_HEADER,
	HOOK_HTTP_TOKEN_HEADER,
	QUARTERDECK_HOOK_HTTP_TOKEN_ENV,
} from "../../../src/terminal/hook-http-channel";
import {
	QUARTERDECK_HOOK_PROJECT_ID_ENV,
	QUARTERDECK_HOOK_SESSION_INSTANCE_ID_ENV,
	QUARTERDECK_HOOK_TASK_ID_ENV,
} from "../../../src/terminal/hook-runtime-context";
import {
	buildPiLifecycleExtensionSource,
	QUARTERDECK_PI_HOOK_COMMAND_ENV,
	QUARTERDECK_PI_HOOK_HTTP_URL_ENV,
	QUARTERDECK_PI_WORKTREE_TRUST_SCOPE_ENV,
} from "../../../src/terminal/pi-lifecycle-extension";
import { useProcessTestBudget } from "../../utilities/process-test-budget";

// captureLifecycleHooks below spawns several real, serial Node child
// processes per test. Heavy machine load can push that well past the fast
// lane's default testTimeout/hookTimeout even though nothing is actually
// hung.
useProcessTestBudget();

const HOOK_COMMAND_ENV_PLACEHOLDER = "__QUARTERDECK_PI_HOOK_COMMAND_ENV__";
const HOOK_HTTP_URL_ENV_PLACEHOLDER = "__QUARTERDECK_PI_HOOK_HTTP_URL_ENV__";
const WORKTREE_TRUST_SCOPE_ENV_PLACEHOLDER = "__QUARTERDECK_PI_WORKTREE_TRUST_SCOPE_ENV__";
const PI_LIFECYCLE_RUNTIME_ASSET_URL = new URL(
	"../../../src/terminal/pi-lifecycle-extension.runtime.js",
	import.meta.url,
);

function readPiLifecycleRuntimeAsset(): string {
	return readFileSync(fileURLToPath(PI_LIFECYCLE_RUNTIME_ASSET_URL), "utf8");
}

function expectNodeSyntaxCheck(filePath: string): void {
	const result = spawnSync(process.execPath, ["--check", filePath], {
		encoding: "utf8",
	});
	expect(result.status, result.stderr || result.stdout).toBe(0);
}

function listenerBlock(source: string, eventName: string): string {
	const start = source.indexOf(`pi.on("${eventName}"`);
	expect(start).toBeGreaterThanOrEqual(0);
	const next = source.indexOf("\n\tpi.on(", start + 1);
	return next === -1 ? source.slice(start) : source.slice(start, next);
}

interface PiExtensionContextHarness {
	cwd?: string;
	ui: {
		notify(message: string, type?: string): void;
	};
	sessionManager: {
		getSessionId(): string;
		// pi-subagents resolves its own "current session" as
		// `getSessionFile() ?? getSessionId()`, so the sessionId it reports on
		// async lifecycle events is often this file-path form instead.
		getSessionFile?(): string | null;
	};
	// Real Pi's extension-context method the extension consults when a
	// deferred Review's wake-grace timer expires, to avoid flushing while Pi
	// is still mid-turn.
	isIdle?(): boolean;
}

type PiEventHandlerHarness = (
	event: Record<string, unknown>,
	context: PiExtensionContextHarness,
) => unknown | Promise<unknown>;

/**
 * Minimal stand-in for Pi's shared cross-extension bus (`pi.events`), which
 * the third-party `pi-subagents` extension uses to announce background
 * worker lifecycle (`subagent:async-started` / `subagent:async-complete`).
 * Real Pi's bus signature is `on(channel, handler) => unsubscribe` plus
 * `emit`; this harness only needs enough of that to drive the extension's
 * listeners from a test.
 */
interface PiLifecycleEventsBusHarness {
	on(channel: string, handler: (payload: unknown) => void): () => void;
	emit(channel: string, payload: unknown): void;
}

function createEventsBusHarness(): PiLifecycleEventsBusHarness {
	const channelHandlers = new Map<string, Set<(payload: unknown) => void>>();
	return {
		on(channel, handler) {
			let handlers = channelHandlers.get(channel);
			if (!handlers) {
				handlers = new Set();
				channelHandlers.set(channel, handlers);
			}
			handlers.add(handler);
			return () => {
				handlers?.delete(handler);
			};
		},
		emit(channel, payload) {
			for (const handler of channelHandlers.get(channel) ?? []) {
				handler(payload);
			}
		},
	};
}

function flagValue(args: string[], flag: string): string | undefined {
	const index = args.indexOf(flag);
	return index === -1 ? undefined : args[index + 1];
}

interface PiExtensionApiHarness {
	on(eventName: string, handler: PiEventHandlerHarness): void;
	events?: PiLifecycleEventsBusHarness;
}

async function loadPiLifecycleExtension(): Promise<(pi: PiExtensionApiHarness) => void> {
	const tempDir = await mkdtemp(join(tmpdir(), "quarterdeck-pi-extension-runtime-"));
	const emittedPath = join(tempDir, "quarterdeck-lifecycle.mjs");
	try {
		await writeFile(emittedPath, buildPiLifecycleExtensionSource(), "utf8");
		const loaded: unknown = await import(pathToFileURL(emittedPath).href);
		if (!loaded || typeof loaded !== "object" || !("default" in loaded) || typeof loaded.default !== "function") {
			throw new Error("Pi lifecycle extension did not export a default initializer.");
		}
		return loaded.default as (pi: PiExtensionApiHarness) => void;
	} finally {
		await rm(tempDir, { recursive: true, force: true });
	}
}

interface CaptureLifecycleHooksOptions {
	/**
	 * Shared `pi.events` bus to attach to the harness `pi` object. Pass
	 * `null` to omit the `events` field entirely, simulating a Pi host build
	 * without the shared extension bus (today's shape). Omit the option to
	 * get a working in-memory bus; pass one explicitly to reuse/inspect it.
	 */
	events?: PiLifecycleEventsBusHarness | null;
	/**
	 * After the expected hooks have arrived, keep waiting this long (real
	 * time) and re-assert the count is still unchanged. Used for negative
	 * assertions that a deferred hook was NOT emitted once the background
	 * wake-grace window (nominally 1.5s) has fully elapsed.
	 */
	verifyNoFurtherHookForMs?: number;
}

async function captureLifecycleHooks(
	emit: (
		handlers: Map<string, PiEventHandlerHarness>,
		context: PiExtensionContextHarness,
		events: PiLifecycleEventsBusHarness,
	) => void,
	expectedCount: number,
	options: CaptureLifecycleHooksOptions = {},
): Promise<string[][]> {
	const initialize = await loadPiLifecycleExtension();
	const handlers = new Map<string, PiEventHandlerHarness>();
	const events = options.events === null ? undefined : (options.events ?? createEventsBusHarness());
	const api: PiExtensionApiHarness = { on: (eventName, handler) => handlers.set(eventName, handler) };
	if (events) {
		api.events = events;
	}
	initialize(api);
	const tempDir = await mkdtemp(join(tmpdir(), "quarterdeck-pi-hook-capture-"));
	const helperPath = join(tempDir, "capture-hook.mjs");
	const outputPath = join(tempDir, "hooks.jsonl");
	await writeFile(
		helperPath,
		'import { appendFileSync } from "node:fs";\nappendFileSync(process.env.QD_TEST_PI_HOOK_OUTPUT, JSON.stringify(process.argv.slice(2)) + "\\n");\n',
		"utf8",
	);
	const context: PiExtensionContextHarness = {
		ui: { notify: vi.fn() },
		sessionManager: {
			getSessionId: () => "pi-session-1",
			getSessionFile: () => "/sessions/pi-session-1.json",
		},
		isIdle: () => true,
	};
	const originalHookCommand = process.env[QUARTERDECK_PI_HOOK_COMMAND_ENV];
	const originalOutputPath = process.env.QD_TEST_PI_HOOK_OUTPUT;
	process.env[QUARTERDECK_PI_HOOK_COMMAND_ENV] = JSON.stringify([process.execPath, helperPath, "notify"]);
	process.env.QD_TEST_PI_HOOK_OUTPUT = outputPath;
	async function readHookLines(): Promise<string[]> {
		return (await readFile(outputPath, "utf8"))
			.trim()
			.split("\n")
			.filter((line) => line.length > 0);
	}
	try {
		emit(handlers, context, events ?? createEventsBusHarness());
		await vi.waitFor(
			async () => {
				expect(await readHookLines()).toHaveLength(expectedCount);
			},
			// Up to 5 serial real Node spawns, plus the background wake-grace
			// window on some cases; 30s raced heavy load even though each hook
			// was progressing normally, just more slowly.
			{ timeout: 30_000 },
		);
		if (options.verifyNoFurtherHookForMs) {
			await new Promise((resolve) => setTimeout(resolve, options.verifyNoFurtherHookForMs));
			expect(await readHookLines()).toHaveLength(expectedCount);
		}
		return (await readHookLines()).map((line) => JSON.parse(line) as string[]);
	} finally {
		if (originalHookCommand === undefined) delete process.env[QUARTERDECK_PI_HOOK_COMMAND_ENV];
		else process.env[QUARTERDECK_PI_HOOK_COMMAND_ENV] = originalHookCommand;
		if (originalOutputPath === undefined) delete process.env.QD_TEST_PI_HOOK_OUTPUT;
		else process.env.QD_TEST_PI_HOOK_OUTPUT = originalOutputPath;
		await rm(tempDir, { recursive: true, force: true });
	}
}

describe("Pi lifecycle extension source", () => {
	it("emits the runtime asset with only the launch environment placeholders substituted", () => {
		const assetSource = readPiLifecycleRuntimeAsset();
		const source = buildPiLifecycleExtensionSource();

		expect(assetSource.split(HOOK_COMMAND_ENV_PLACEHOLDER)).toHaveLength(2);
		expect(assetSource.split(HOOK_HTTP_URL_ENV_PLACEHOLDER)).toHaveLength(2);
		expect(assetSource.split(WORKTREE_TRUST_SCOPE_ENV_PLACEHOLDER)).toHaveLength(2);
		expect(assetSource).not.toContain(QUARTERDECK_PI_HOOK_COMMAND_ENV);
		expect(source).toBe(
			assetSource
				.replace(HOOK_COMMAND_ENV_PLACEHOLDER, QUARTERDECK_PI_HOOK_COMMAND_ENV)
				.replace(HOOK_HTTP_URL_ENV_PLACEHOLDER, QUARTERDECK_PI_HOOK_HTTP_URL_ENV)
				.replace(WORKTREE_TRUST_SCOPE_ENV_PLACEHOLDER, QUARTERDECK_PI_WORKTREE_TRUST_SCOPE_ENV),
		);
		expect(source).toContain(`const HOOK_COMMAND_ENV = "${QUARTERDECK_PI_HOOK_COMMAND_ENV}";`);
		expect(source).toContain(`const HOOK_HTTP_URL_ENV = "${QUARTERDECK_PI_HOOK_HTTP_URL_ENV}";`);
		expect(source).not.toContain(HOOK_COMMAND_ENV_PLACEHOLDER);
		expect(source).not.toContain(HOOK_HTTP_URL_ENV_PLACEHOLDER);
		expect(source).not.toContain(WORKTREE_TRUST_SCOPE_ENV_PLACEHOLDER);
	});

	it("keeps its hardcoded HTTP header and identity/credential env names in sync with hook-http-channel.ts and hook-runtime-context.ts", () => {
		const source = buildPiLifecycleExtensionSource();

		expect(source).toContain(`const HOOK_HTTP_TOKEN_ENV = "${QUARTERDECK_HOOK_HTTP_TOKEN_ENV}";`);
		expect(source).toContain(`const HOOK_HTTP_TASK_ID_ENV = "${QUARTERDECK_HOOK_TASK_ID_ENV}";`);
		expect(source).toContain(`const HOOK_HTTP_PROJECT_ID_ENV = "${QUARTERDECK_HOOK_PROJECT_ID_ENV}";`);
		expect(source).toContain(
			`const HOOK_HTTP_SESSION_INSTANCE_ID_ENV = "${QUARTERDECK_HOOK_SESSION_INSTANCE_ID_ENV}";`,
		);
		expect(source).toContain(`const HOOK_HTTP_TOKEN_HEADER = "${HOOK_HTTP_TOKEN_HEADER}";`);
		expect(source).toContain(`const HOOK_HTTP_TASK_ID_HEADER = "${HOOK_HTTP_TASK_ID_HEADER}";`);
		expect(source).toContain(`const HOOK_HTTP_PROJECT_ID_HEADER = "${HOOK_HTTP_PROJECT_ID_HEADER}";`);
		expect(source).toContain(
			`const HOOK_HTTP_SESSION_INSTANCE_ID_HEADER = "${HOOK_HTTP_SESSION_INSTANCE_ID_HEADER}";`,
		);
	});

	it("keeps the runtime asset and emitted extension parseable by Node", async () => {
		const assetPath = fileURLToPath(PI_LIFECYCLE_RUNTIME_ASSET_URL);
		const tempDir = await mkdtemp(join(tmpdir(), "quarterdeck-pi-extension-"));
		const emittedPath = join(tempDir, "quarterdeck-lifecycle.mjs");

		try {
			await writeFile(emittedPath, buildPiLifecycleExtensionSource(), "utf8");

			expectNodeSyntaxCheck(assetPath);
			expectNodeSyntaxCheck(emittedPath);
		} finally {
			await rm(tempDir, { recursive: true, force: true });
		}
	});

	it("gives durable `hooks ingest` enough budget to survive heavy machine load without losing a to_review", () => {
		const source = buildPiLifecycleExtensionSource();

		// Durable (waitForExit) hooks are killed and treated as finished once this
		// timer fires, which can drop a to_review transition if a slow CLI under
		// load hasn't durably persisted yet. Keep it generous; non-durable
		// `notify` hooks never pass through this timeout at all.
		expect(source).toContain("const DURABLE_HOOK_TIMEOUT_MS = 30_000;");
	});

	it("registers the Pi lifecycle events Quarterdeck maps into hook state", () => {
		const source = buildPiLifecycleExtensionSource();
		const eventNames = [
			"session_start",
			"session_shutdown",
			"session_before_switch",
			"session_before_fork",
			"agent_start",
			"agent_end",
			"agent_settled",
			"tool_execution_start",
			"tool_execution_update",
			"tool_execution_end",
		];

		for (const eventName of eventNames) {
			expect(source).toContain(`pi.on("${eventName}"`);
		}
	});

	it("serializes durable state hooks so lifecycle transitions cannot overtake each other", () => {
		const source = buildPiLifecycleExtensionSource();

		expect(source).toContain("let durableHookQueue = Promise.resolve();");
		expect(source).toContain("function enqueueDurableHook");
		expect(source).toContain("function selectHookCommandArgs");
		expect(source).toContain('durableArgs[durableArgs.length - 1] = "ingest";');
		expect(source).toContain("waitForExit: true");
		expect(listenerBlock(source, "session_start")).toMatch(/enqueueDurableHook\(\s*"activity"/);
		expect(listenerBlock(source, "agent_start")).toMatch(/enqueueDurableHook\(\s*"to_in_progress"/);
		expect(listenerBlock(source, "agent_end")).toMatch(/enqueueDurableHook\(\s*"activity"/);
		expect(listenerBlock(source, "agent_settled")).toMatch(/enqueueDurableHook\(\s*"to_review"/);
		expect(listenerBlock(source, "agent_settled")).toMatch(
			/hookEventName: aborted \? "Interrupt" : failed \? "StopFailure" : "AgentSettled"/,
		);
	});

	it("freezes each queued saved source path without truncating long custom profile paths", async () => {
		const firstPath = `/custom/My  Repo\t/${"profile/".repeat(100)}first.jsonl`;
		const secondPath = "/other/Two  Spaces\t/second.jsonl";
		const calls = await captureLifecycleHooks((handlers, context) => {
			context.sessionManager.getSessionFile = () => firstPath;
			handlers.get("session_start")?.({}, context);
			context.sessionManager.getSessionFile = () => secondPath;
			handlers.get("agent_start")?.({}, context);
		}, 2);
		expect(flagValue(calls[0], "--transcript-path")).toBe(firstPath);
		expect(flagValue(calls[1], "--transcript-path")).toBe(secondPath);
	});

	it("freezes each queued hook to the run identity active when it was enqueued", async () => {
		const calls = await captureLifecycleHooks((handlers, context) => {
			handlers.get("session_start")?.({}, context);
			handlers.get("agent_start")?.({}, context);
			handlers.get("agent_start")?.({}, context);
		}, 3);
		expect(calls[0]).not.toContain("--turn-id");
		const turnIds = calls.slice(1).map((args) => args[args.indexOf("--turn-id") + 1]);
		expect(turnIds).toEqual([expect.any(String), expect.any(String)]);
		expect(turnIds[0]).not.toBe(turnIds[1]);
	});

	it.each([false, true])(
		"reports aborted=%s settlement without promoting interrupted output to completion",
		async (aborted) => {
			const calls = await captureLifecycleHooks((handlers, context) => {
				handlers.get("agent_start")?.({}, context);
				handlers.get("agent_end")?.(
					{ messages: [{ role: "assistant", content: [{ type: "text", text: "Partial response" }] }] },
					context,
				);
				handlers.get("agent_settled")?.({ aborted }, context);
			}, 3);
			const start = calls[0];
			const settled = calls[2];
			expect(settled).toContain("ingest");
			expect(settled[settled.indexOf("--event") + 1]).toBe("to_review");
			expect(settled[settled.indexOf("--hook-event-name") + 1]).toBe(aborted ? "Interrupt" : "AgentSettled");
			expect(settled[settled.indexOf("--turn-id") + 1]).toBe(start[start.indexOf("--turn-id") + 1]);
			expect(settled[settled.indexOf("--session-id") + 1]).toBe("pi-session-1");
			if (aborted) {
				expect(settled).not.toContain("--final-message");
				expect(settled).not.toContain("Partial response");
			} else {
				expect(settled[settled.indexOf("--final-message") + 1]).toBe("Partial response");
			}
		},
	);

	it.each([false, true])("distinguishes final errors from recovered retries (recovered=%s)", async (recovered) => {
		const calls = await captureLifecycleHooks(
			(handlers, context) => {
				handlers.get("agent_start")?.({}, context);
				handlers.get("agent_end")?.(
					{
						messages: [
							{
								role: "assistant",
								content: [{ type: "text", text: "Earlier reasoning" }],
								stopReason: "toolUse",
							},
							{
								role: "assistant",
								content: [],
								stopReason: "error",
								errorMessage: "Synthetic provider failure",
							},
						],
					},
					context,
				);
				if (recovered) {
					handlers.get("agent_start")?.({}, context);
					handlers.get("agent_end")?.(
						{
							messages: [
								{
									role: "assistant",
									content: [{ type: "text", text: "Recovered result" }],
									stopReason: "stop",
								},
							],
						},
						context,
					);
				}
				handlers.get("agent_settled")?.({ aborted: false }, context);
			},
			recovered ? 5 : 3,
		);
		const settled = calls.at(-1);
		expect(settled).toBeDefined();
		if (!settled) throw new Error("Missing settlement hook");
		expect(settled[settled.indexOf("--hook-event-name") + 1]).toBe(recovered ? "AgentSettled" : "StopFailure");
		if (recovered) expect(settled[settled.indexOf("--final-message") + 1]).toBe("Recovered result");
		else expect(settled).not.toContain("--final-message");
	});

	it("does not emit hook processes for high-volume tool execution updates", () => {
		const source = buildPiLifecycleExtensionSource();
		const block = listenerBlock(source, "tool_execution_update");

		expect(block).toContain("rememberToolInput(event);");
		expect(block).not.toContain("emitQuarterdeckHook");
		expect(block).not.toContain("enqueueDurableHook");
	});

	it("caches tool input so end events can report summaries without args", () => {
		const source = buildPiLifecycleExtensionSource();
		const startBlock = listenerBlock(source, "tool_execution_start");
		const updateBlock = listenerBlock(source, "tool_execution_update");
		const endBlock = listenerBlock(source, "tool_execution_end");

		expect(source).toContain("const toolInputsById = new Map();");
		expect(startBlock).toContain("const toolInput = rememberToolInput(event);");
		expect(updateBlock).toContain("rememberToolInput(event);");
		expect(endBlock).toContain("const toolInput = resolveToolInput(event);");
		expect(endBlock).toContain("forgetToolInput(event);");
	});

	it("leaves tool execution to Pi and registers launch-scoped project trust", async () => {
		const initialize = await loadPiLifecycleExtension();
		const handlers = new Map<string, PiEventHandlerHarness>();
		initialize({ on: (eventName, handler) => handlers.set(eventName, handler) });
		expect(handlers.has("tool_call")).toBe(false);
		expect(handlers.has("project_trust")).toBe(true);
		expect(handlers.has("input")).toBe(false);
		expect(handlers.has("tool_execution_start")).toBe(true);
		expect(handlers.has("agent_settled")).toBe(true);
	});
});

describe("Pi session-only worktree trust", () => {
	afterEach(() => vi.unstubAllEnvs());

	async function prepareTrustHandler(scope: string | undefined): Promise<PiEventHandlerHarness> {
		vi.stubEnv(QUARTERDECK_PI_WORKTREE_TRUST_SCOPE_ENV, scope);
		vi.stubEnv(QUARTERDECK_HOOK_TASK_ID_ENV, "task-pi");
		vi.stubEnv(QUARTERDECK_HOOK_PROJECT_ID_ENV, "project-pi");
		vi.stubEnv(QUARTERDECK_HOOK_SESSION_INSTANCE_ID_ENV, "launch-pi");
		return await initializeTrustHandler();
	}

	async function initializeTrustHandler(): Promise<PiEventHandlerHarness> {
		const initialize = await loadPiLifecycleExtension();
		const handlers = new Map<string, PiEventHandlerHarness>();
		initialize({ on: (eventName, handler) => handlers.set(eventName, handler) });
		const handler = handlers.get("project_trust");
		if (!handler) throw new Error("Expected project_trust handler.");
		return handler;
	}

	function context(cwd?: string): PiExtensionContextHarness {
		return { cwd, ui: { notify: vi.fn() }, sessionManager: { getSessionId: () => "pi-session" } };
	}

	it("trusts only the exact canonical launch checkout without remembering, including a reload", async () => {
		const tempDir = await mkdtemp(join(tmpdir(), "quarterdeck-pi-trust-"));
		try {
			const scope = await realpath(tempDir);
			const handler = await prepareTrustHandler(scope);
			expect(await handler({ cwd: scope }, context(scope))).toEqual({ trusted: "yes", remember: false });
			// Later env mutation cannot move this extension's launch authority.
			vi.stubEnv(QUARTERDECK_PI_WORKTREE_TRUST_SCOPE_ENV, join(scope, "other"));
			expect(await handler({ cwd: scope }, context(scope))).toEqual({ trusted: "yes", remember: false });
			vi.stubEnv(QUARTERDECK_PI_WORKTREE_TRUST_SCOPE_ENV, scope);
			const reloadedHandler = await initializeTrustHandler();
			expect(await reloadedHandler({ cwd: scope }, context(scope))).toEqual({ trusted: "yes", remember: false });
		} finally {
			await rm(tempDir, { recursive: true, force: true });
		}
	});

	it("defers when scope or any managed launch identity is missing", async () => {
		const tempDir = await mkdtemp(join(tmpdir(), "quarterdeck-pi-trust-"));
		try {
			const scope = await realpath(tempDir);
			const noScope = await prepareTrustHandler(undefined);
			expect(await noScope({ cwd: scope }, context(scope))).toEqual({ trusted: "undecided" });
			for (const key of [
				QUARTERDECK_HOOK_TASK_ID_ENV,
				QUARTERDECK_HOOK_PROJECT_ID_ENV,
				QUARTERDECK_HOOK_SESSION_INSTANCE_ID_ENV,
			]) {
				await prepareTrustHandler(scope);
				vi.stubEnv(key, " ");
				const handler = await initializeTrustHandler();
				expect(await handler({ cwd: scope }, context(scope))).toEqual({ trusted: "undecided" });
			}
		} finally {
			await rm(tempDir, { recursive: true, force: true });
		}
	});

	it("defers for other directories, children, sibling prefixes, or conflicting event/context cwd", async () => {
		const tempDir = await mkdtemp(join(tmpdir(), "quarterdeck-pi-trust-"));
		try {
			const scope = join(await realpath(tempDir), "worktree");
			await mkdir(join(scope, "child"), { recursive: true });
			await mkdir(`${scope}-sibling`);
			const handler = await prepareTrustHandler(scope);
			for (const cwd of [tempDir, join(scope, "child"), `${scope}-sibling`, join(scope, "absent")]) {
				expect(await handler({ cwd }, context(cwd))).toEqual({ trusted: "undecided" });
				expect(await handler({ cwd: scope }, context(cwd))).toEqual({ trusted: "undecided" });
				expect(await handler({ cwd }, context(scope))).toEqual({ trusted: "undecided" });
			}
			expect(await handler({ cwd: scope }, context())).toEqual({ trusted: "undecided" });
			expect(await handler({}, context(scope))).toEqual({ trusted: "undecided" });
			expect(await handler({ cwd: "." }, context(scope))).toEqual({ trusted: "undecided" });
		} finally {
			await rm(tempDir, { recursive: true, force: true });
		}
	});

	it("accepts aliases of the same checkout but rejects deleted or symlink-redirected launch paths", async () => {
		const tempDir = await mkdtemp(join(tmpdir(), "quarterdeck-pi-trust-"));
		try {
			const root = await realpath(tempDir);
			const scope = join(root, "worktree");
			const outside = join(root, "outside");
			const alias = join(root, "alias");
			await mkdir(scope);
			await mkdir(outside);
			await symlink(scope, alias, process.platform === "win32" ? "junction" : "dir");
			const handler = await prepareTrustHandler(scope);
			expect(await handler({ cwd: alias }, context(alias))).toEqual({ trusted: "yes", remember: false });
			await rename(scope, join(root, "original"));
			expect(await handler({ cwd: scope }, context(scope))).toEqual({ trusted: "undecided" });
			await symlink(outside, scope, process.platform === "win32" ? "junction" : "dir");
			expect(await handler({ cwd: scope }, context(scope))).toEqual({ trusted: "undecided" });
			expect(await handler({ cwd: outside }, context(outside))).toEqual({ trusted: "undecided" });
		} finally {
			await rm(tempDir, { recursive: true, force: true });
		}
	});
});

// Mirrors the pi-subagents contract (see plan): the shared `pi.events` bus
// carries `"subagent:async-started"` / `"subagent:async-complete"` so a
// background worker can keep a Pi task out of Review while the main agent
// has already settled. These literal channel names and the 3s wake-grace
// window are part of the cross-implementation contract with
// `pi-lifecycle-extension.runtime.js`.
const SUBAGENT_ASYNC_STARTED_EVENT = "subagent:async-started";
const SUBAGENT_ASYNC_COMPLETE_EVENT = "subagent:async-complete";
const BACKGROUND_WAKE_GRACE_MS = 3_000;

describe("Pi lifecycle extension background subagent handling", () => {
	it("defers settlement to a durable AgentSettledBackgroundPending activity while a background run is pending, then flushes to_review once it completes", async () => {
		const calls = await captureLifecycleHooks((handlers, context, events) => {
			handlers.get("agent_start")?.({}, context);
			events.emit(SUBAGENT_ASYNC_STARTED_EVENT, { id: "bg-1" });
			handlers.get("agent_end")?.(
				{ messages: [{ role: "assistant", content: [{ type: "text", text: "All done" }] }] },
				context,
			);
			handlers.get("agent_settled")?.({ aborted: false }, context);
			events.emit(SUBAGENT_ASYNC_COMPLETE_EVENT, { id: "bg-1" });
		}, 4);

		const start = calls[0];
		const pending = calls[2];
		const flushed = calls[3];
		if (!start || !pending || !flushed) throw new Error("Missing expected hook calls");

		expect(flagValue(pending, "--event")).toBe("activity");
		expect(flagValue(pending, "--hook-event-name")).toBe("AgentSettledBackgroundPending");
		// A final message the agent already produced (e.g. a question) stays
		// visible alongside the pending-background notice.
		expect(flagValue(pending, "--activity-text")).toMatch(/^1 background subagent running · Final: All done$/);
		expect(flagValue(pending, "--turn-id")).toBe(flagValue(start, "--turn-id"));
		expect(flagValue(pending, "--final-message")).toBe("All done");

		expect(flagValue(flushed, "--event")).toBe("to_review");
		expect(flagValue(flushed, "--hook-event-name")).toBe("AgentSettled");
		expect(flagValue(flushed, "--turn-id")).toBe(flagValue(start, "--turn-id"));
		expect(flagValue(flushed, "--session-id")).toBe("pi-session-1");
		expect(flagValue(flushed, "--final-message")).toBe("All done");
	});

	it("drops the deferred settlement when a new agent_start arrives within the wake-grace window, so the old run never gets a late to_review", async () => {
		const calls = await captureLifecycleHooks(
			(handlers, context, events) => {
				handlers.get("agent_start")?.({}, context);
				events.emit(SUBAGENT_ASYNC_STARTED_EVENT, { id: "bg-1" });
				handlers.get("agent_end")?.(
					{ messages: [{ role: "assistant", content: [{ type: "text", text: "Partial" }] }] },
					context,
				);
				handlers.get("agent_settled")?.({ aborted: false }, context);
				events.emit(SUBAGENT_ASYNC_COMPLETE_EVENT, { id: "bg-1" });
				handlers.get("agent_start")?.({}, context);
			},
			4,
			// Negative assertion: wait past the wake-grace window and confirm no
			// 5th (stale, deferred) to_review ever arrives for the old run.
			{ verifyNoFurtherHookForMs: BACKGROUND_WAKE_GRACE_MS + 1_000 },
		);

		const firstStart = calls[0];
		const secondStart = calls[3];
		if (!firstStart || !secondStart) throw new Error("Missing expected hook calls");

		expect(flagValue(secondStart, "--event")).toBe("to_in_progress");
		expect(flagValue(secondStart, "--hook-event-name")).toBe("AgentStart");
		expect(flagValue(secondStart, "--turn-id")).not.toBe(flagValue(firstStart, "--turn-id"));
		expect(calls.some((args) => flagValue(args, "--event") === "to_review")).toBe(false);
	});

	it("still emits an immediate to_review Interrupt on an aborted settle even with a background run pending", async () => {
		const calls = await captureLifecycleHooks((handlers, context, events) => {
			handlers.get("agent_start")?.({}, context);
			events.emit(SUBAGENT_ASYNC_STARTED_EVENT, { id: "bg-1" });
			handlers.get("agent_settled")?.({ aborted: true }, context);
		}, 2);

		const settled = calls[1];
		if (!settled) throw new Error("Missing settlement hook");
		expect(flagValue(settled, "--event")).toBe("to_review");
		expect(flagValue(settled, "--hook-event-name")).toBe("Interrupt");
		expect(settled).not.toContain("--final-message");
	});

	it("ends the deferred run with an Interrupt when an abort settles before the next agent_start", async () => {
		const calls = await captureLifecycleHooks(
			(handlers, context, events) => {
				handlers.get("agent_start")?.({}, context);
				events.emit(SUBAGENT_ASYNC_STARTED_EVENT, { id: "bg-1" });
				handlers.get("agent_settled")?.({ aborted: false }, context);
				// Pi can abort a starting run before agent_start and still settle it.
				handlers.get("agent_settled")?.({ aborted: true }, context);
				events.emit(SUBAGENT_ASYNC_COMPLETE_EVENT, { id: "bg-1" });
			},
			3,
			{ verifyNoFurtherHookForMs: BACKGROUND_WAKE_GRACE_MS + 1_000 },
		);

		const start = calls[0];
		const interrupted = calls[2];
		if (!start || !interrupted) throw new Error("Missing expected hook calls");
		expect(flagValue(interrupted, "--event")).toBe("to_review");
		expect(flagValue(interrupted, "--hook-event-name")).toBe("Interrupt");
		expect(flagValue(interrupted, "--turn-id")).toBe(flagValue(start, "--turn-id"));
	});

	it("ignores an async-started event reported for a different Pi session, including a mismatching session file path", async () => {
		const calls = await captureLifecycleHooks((handlers, context, events) => {
			handlers.get("agent_start")?.({}, context);
			// Neither form (plain id nor pi-subagents' preferred session-file
			// path) matches this harness's session, so this must be ignored
			// even though it looks like a legitimate file-path identity.
			events.emit(SUBAGENT_ASYNC_STARTED_EVENT, { id: "bg-1", sessionId: "/sessions/some-other-session.json" });
			handlers.get("agent_end")?.(
				{ messages: [{ role: "assistant", content: [{ type: "text", text: "Done" }] }] },
				context,
			);
			handlers.get("agent_settled")?.({ aborted: false }, context);
		}, 3);

		const settled = calls[2];
		if (!settled) throw new Error("Missing settlement hook");
		expect(flagValue(settled, "--event")).toBe("to_review");
		expect(flagValue(settled, "--hook-event-name")).toBe("AgentSettled");
		expect(flagValue(settled, "--final-message")).toBe("Done");
	});

	it("behaves exactly as today when the Pi host has no pi.events bus", async () => {
		const calls = await captureLifecycleHooks(
			(handlers, context) => {
				handlers.get("agent_start")?.({}, context);
				handlers.get("agent_end")?.(
					{ messages: [{ role: "assistant", content: [{ type: "text", text: "Done" }] }] },
					context,
				);
				handlers.get("agent_settled")?.({ aborted: false }, context);
			},
			3,
			{ events: null },
		);

		const settled = calls[2];
		if (!settled) throw new Error("Missing settlement hook");
		expect(flagValue(settled, "--event")).toBe("to_review");
		expect(flagValue(settled, "--hook-event-name")).toBe("AgentSettled");
		expect(flagValue(settled, "--final-message")).toBe("Done");
	});

	it("clears tracked background runs on session_start, so a later settlement is not deferred", async () => {
		const calls = await captureLifecycleHooks((handlers, context, events) => {
			handlers.get("agent_start")?.({}, context);
			events.emit(SUBAGENT_ASYNC_STARTED_EVENT, { id: "bg-1" });
			handlers.get("session_start")?.({}, context);
			handlers.get("agent_start")?.({}, context);
			handlers.get("agent_end")?.(
				{ messages: [{ role: "assistant", content: [{ type: "text", text: "Done" }] }] },
				context,
			);
			handlers.get("agent_settled")?.({ aborted: false }, context);
		}, 5);

		const settled = calls[4];
		if (!settled) throw new Error("Missing settlement hook");
		expect(flagValue(settled, "--event")).toBe("to_review");
		expect(flagValue(settled, "--hook-event-name")).toBe("AgentSettled");
		expect(flagValue(settled, "--final-message")).toBe("Done");
	});

	it("flushes a deferred Review (with its captured turn/session identity) before clearing tracking on session_start, instead of silently losing it", async () => {
		const calls = await captureLifecycleHooks((handlers, context, events) => {
			handlers.get("agent_start")?.({}, context);
			events.emit(SUBAGENT_ASYNC_STARTED_EVENT, { id: "bg-1" });
			handlers.get("agent_settled")?.({ aborted: false }, context);
			// Reload/session replacement arrives before the background run
			// ever completes. The previous turn's deferred Review must still
			// be recorded, not dropped, before the new session's own hook.
			handlers.get("session_start")?.({}, context);
		}, 4);

		const start = calls[0];
		const flushed = calls[2];
		const newSessionMeta = calls[3];
		if (!start || !flushed || !newSessionMeta) throw new Error("Missing expected hook calls");

		expect(flagValue(flushed, "--event")).toBe("to_review");
		expect(flagValue(flushed, "--hook-event-name")).toBe("AgentSettled");
		expect(flagValue(flushed, "--turn-id")).toBe(flagValue(start, "--turn-id"));
		expect(flagValue(flushed, "--session-id")).toBe("pi-session-1");

		expect(flagValue(newSessionMeta, "--event")).toBe("activity");
		expect(flagValue(newSessionMeta, "--hook-event-name")).toBe("session_meta");
	});

	it("flushes a deferred Review before clearing tracking on session_shutdown", async () => {
		const calls = await captureLifecycleHooks((handlers, context, events) => {
			handlers.get("agent_start")?.({}, context);
			events.emit(SUBAGENT_ASYNC_STARTED_EVENT, { id: "bg-1" });
			handlers.get("agent_settled")?.({ aborted: false }, context);
			handlers.get("session_shutdown")?.({}, context);
		}, 3);

		const start = calls[0];
		const flushed = calls[2];
		if (!start || !flushed) throw new Error("Missing expected hook calls");
		expect(flagValue(flushed, "--event")).toBe("to_review");
		expect(flagValue(flushed, "--hook-event-name")).toBe("AgentSettled");
		expect(flagValue(flushed, "--turn-id")).toBe(flagValue(start, "--turn-id"));
	});

	it("tracks an async-started run reported with pi-subagents' preferred session-file identity, not just getSessionId()", async () => {
		// pi-subagents resolves its own current-session id as
		// `sessionManager.getSessionFile() ?? getSessionId()`, so the
		// sessionId on its events is often this file-path form. The default
		// test context's getSessionFile() returns "/sessions/pi-session-1.json".
		const calls = await captureLifecycleHooks((handlers, context, events) => {
			handlers.get("agent_start")?.({}, context);
			events.emit(SUBAGENT_ASYNC_STARTED_EVENT, { id: "bg-1", sessionId: "/sessions/pi-session-1.json" });
			handlers.get("agent_settled")?.({ aborted: false }, context);
			events.emit(SUBAGENT_ASYNC_COMPLETE_EVENT, { id: "bg-1", triggerTurn: false });
		}, 3);

		const pending = calls[1];
		const flushed = calls[2];
		if (!pending || !flushed) throw new Error("Missing expected hook calls");
		expect(flagValue(pending, "--hook-event-name")).toBe("AgentSettledBackgroundPending");
		expect(flagValue(flushed, "--event")).toBe("to_review");
		expect(flagValue(flushed, "--hook-event-name")).toBe("AgentSettled");
	});

	it("flushes the deferred Review promptly, without waiting out the wake-grace window, when the final completion signals no wake turn is coming", async () => {
		const calls = await captureLifecycleHooks((handlers, context, events) => {
			handlers.get("agent_start")?.({}, context);
			events.emit(SUBAGENT_ASYNC_STARTED_EVENT, { id: "bg-1" });
			handlers.get("agent_settled")?.({ aborted: false }, context);
			// triggerTurn: false (or intercomDelivered: true) means pi-subagents
			// is not about to wake the parent with a fresh turn, so there is no
			// reason to wait out the wake-grace window at all.
			events.emit(SUBAGENT_ASYNC_COMPLETE_EVENT, { id: "bg-1", triggerTurn: false });
			// A synchronous agent_start would cancel a grace-deferred flush, so the
			// Review only lands before it if the flush was immediate (no timing bound).
			handlers.get("agent_start")?.({}, context);
		}, 4);

		const flushed = calls[2];
		if (!flushed) throw new Error("Missing flushed hook call");
		expect(flagValue(flushed, "--event")).toBe("to_review");
		expect(flagValue(flushed, "--hook-event-name")).toBe("AgentSettled");
		expect(flagValue(calls[3] ?? [], "--event")).toBe("to_in_progress");
	});

	it("keeps a deferred Review waiting past the wake-grace window while ctx.isIdle() reports Pi still busy, until a new agent_start supersedes it", async () => {
		const busyContext: PiExtensionContextHarness = {
			ui: { notify: vi.fn() },
			sessionManager: {
				getSessionId: () => "pi-session-1",
				getSessionFile: () => "/sessions/pi-session-1.json",
			},
			isIdle: () => false,
		};
		const calls = await captureLifecycleHooks(
			(handlers, _context, events) => {
				handlers.get("agent_start")?.({}, busyContext);
				events.emit(SUBAGENT_ASYNC_STARTED_EVENT, { id: "bg-1" });
				handlers.get("agent_settled")?.({ aborted: false }, busyContext);
				events.emit(SUBAGENT_ASYNC_COMPLETE_EVENT, { id: "bg-1" });
				// Scheduled past one full wake-grace window: if the idle check
				// were not re-arming the timer, a (bugged) premature flush would
				// already have landed as call #3 by the time this fires.
				setTimeout(() => {
					handlers.get("agent_start")?.({}, busyContext);
				}, BACKGROUND_WAKE_GRACE_MS + 500);
			},
			3,
			{ verifyNoFurtherHookForMs: BACKGROUND_WAKE_GRACE_MS + 1_000 },
		);

		const secondStart = calls[2];
		if (!secondStart) throw new Error("Missing expected second agent_start hook call");
		expect(flagValue(secondStart, "--event")).toBe("to_in_progress");
		expect(flagValue(secondStart, "--hook-event-name")).toBe("AgentStart");
		expect(calls.some((args) => flagValue(args, "--event") === "to_review")).toBe(false);
	});

	it("drops a workflow coordinator's tracked children once the coordinator itself completes", async () => {
		const calls = await captureLifecycleHooks((handlers, context, events) => {
			handlers.get("agent_start")?.({}, context);
			events.emit(SUBAGENT_ASYNC_STARTED_EVENT, { id: "wf-1", mode: "workflow" });
			events.emit(SUBAGENT_ASYNC_STARTED_EVENT, { id: "wf-1-child", mode: "chain", parentWorkflowRunId: "wf-1" });
			handlers.get("agent_settled")?.({ aborted: false }, context);
			// Completing only the coordinator (never the child) must still
			// unblock the deferred Review: the child is dropped as part of the
			// coordinator's own cleanup rather than held forever.
			events.emit(SUBAGENT_ASYNC_COMPLETE_EVENT, { id: "wf-1", mode: "workflow", triggerTurn: false });
		}, 3);

		const pending = calls[1];
		const flushed = calls[2];
		if (!pending || !flushed) throw new Error("Missing expected hook calls");
		// The workflow coordinator itself is excluded from the displayed
		// count; only its one leaf child is counted.
		expect(flagValue(pending, "--activity-text")).toBe("1 background subagent running");
		expect(flagValue(flushed, "--event")).toBe("to_review");
		expect(flagValue(flushed, "--hook-event-name")).toBe("AgentSettled");
	});

	it("drops tracked children when an unannounced workflow coordinator completes", async () => {
		const calls = await captureLifecycleHooks((handlers, context, events) => {
			handlers.get("agent_start")?.({}, context);
			// A detached foreground workflow never emits async-started for itself.
			events.emit(SUBAGENT_ASYNC_STARTED_EVENT, { id: "wf-1-child", parentWorkflowRunId: "wf-1" });
			handlers.get("agent_settled")?.({ aborted: false }, context);
			events.emit(SUBAGENT_ASYNC_COMPLETE_EVENT, { id: "wf-1", mode: "workflow", triggerTurn: false });
		}, 3);

		const flushed = calls[2];
		if (!flushed) throw new Error("Missing flushed hook call");
		expect(flagValue(flushed, "--event")).toBe("to_review");
		expect(flagValue(flushed, "--hook-event-name")).toBe("AgentSettled");
	});
});

interface CapturedHookHttpRequest {
	method: string | undefined;
	url: string | undefined;
	headers: IncomingMessage["headers"];
	body: Record<string, unknown>;
}

/** Starts a local loopback server that records every POST it receives, mirroring `/api/hooks/notify`. */
async function startHookHttpServer(): Promise<{
	url: string;
	requests: CapturedHookHttpRequest[];
	close: () => Promise<void>;
}> {
	const requests: CapturedHookHttpRequest[] = [];
	const server: Server = createServer((req, res) => {
		const chunks: Buffer[] = [];
		req.on("data", (chunk: Buffer) => chunks.push(chunk));
		req.on("end", () => {
			const bodyText = Buffer.concat(chunks).toString("utf8");
			requests.push({
				method: req.method,
				url: req.url,
				headers: req.headers,
				body: bodyText ? (JSON.parse(bodyText) as Record<string, unknown>) : {},
			});
			res.writeHead(204, { "Cache-Control": "no-store" });
			res.end();
		});
	});
	server.listen(0, "127.0.0.1");
	await once(server, "listening");
	const { port } = server.address() as AddressInfo;
	return {
		url: `http://127.0.0.1:${port}/api/hooks/notify`,
		requests,
		close: () =>
			new Promise<void>((resolve) => {
				server.closeAllConnections();
				server.close(() => resolve());
			}),
	};
}

describe("Pi lifecycle extension best-effort HTTP delivery", () => {
	it("POSTs best-effort activity hooks to the published loopback endpoint instead of spawning, while durable hooks keep spawning `ingest`", async () => {
		const httpServer = await startHookHttpServer();
		const originalEnv = {
			url: process.env[QUARTERDECK_PI_HOOK_HTTP_URL_ENV],
			token: process.env[QUARTERDECK_HOOK_HTTP_TOKEN_ENV],
			taskId: process.env[QUARTERDECK_HOOK_TASK_ID_ENV],
			projectId: process.env[QUARTERDECK_HOOK_PROJECT_ID_ENV],
			sessionInstanceId: process.env[QUARTERDECK_HOOK_SESSION_INSTANCE_ID_ENV],
		};
		process.env[QUARTERDECK_PI_HOOK_HTTP_URL_ENV] = httpServer.url;
		process.env[QUARTERDECK_HOOK_HTTP_TOKEN_ENV] = "test-token";
		process.env[QUARTERDECK_HOOK_TASK_ID_ENV] = "task-http";
		process.env[QUARTERDECK_HOOK_PROJECT_ID_ENV] = "project-http";
		process.env[QUARTERDECK_HOOK_SESSION_INSTANCE_ID_ENV] = "instance-http";
		const sessionFilePath = "/sessions/My  Repo\t/pi-session-1.json";

		try {
			// agent_start's durable `to_in_progress` must still spawn `hooks
			// ingest`; the two best-effort tool_execution hooks below must not
			// spawn anything at all once the HTTP URL env is published.
			await captureLifecycleHooks((handlers, context) => {
				context.sessionManager.getSessionFile = () => sessionFilePath;
				handlers.get("agent_start")?.({}, context);
				handlers.get("tool_execution_start")?.(
					{ toolName: "Bash", toolCallId: "call-1", args: { command: "npm test" } },
					context,
				);
				handlers.get("tool_execution_end")?.({ toolName: "Bash", toolCallId: "call-1", isError: false }, context);
			}, 1);

			await vi.waitFor(() => expect(httpServer.requests).toHaveLength(2));

			const startRequest = httpServer.requests.find(
				(request) => request.body.hook_event_name === "ToolExecutionStart",
			);
			const endRequest = httpServer.requests.find((request) => request.body.hook_event_name === "ToolExecutionEnd");
			if (!startRequest || !endRequest) throw new Error("Missing expected HTTP hook requests");

			for (const request of [startRequest, endRequest]) {
				expect(request.method).toBe("POST");
				const url = new URL(request.url ?? "", "http://localhost");
				expect(url.pathname).toBe("/api/hooks/notify");
				expect(url.searchParams.get("event")).toBe("activity");
				expect(url.searchParams.get("source")).toBe("pi");
				expect(request.headers[HOOK_HTTP_TOKEN_HEADER]).toBe("test-token");
				expect(request.headers[HOOK_HTTP_TASK_ID_HEADER]).toBe("task-http");
				expect(request.headers[HOOK_HTTP_PROJECT_ID_HEADER]).toBe("project-http");
				expect(request.headers[HOOK_HTTP_SESSION_INSTANCE_ID_HEADER]).toBe("instance-http");
				expect(request.body.session_id).toBe("pi-session-1");
				expect(request.body.transcript_path).toBe(sessionFilePath);
				expect(typeof request.body.turn_id).toBe("string");
				expect((request.body.turn_id as string).length).toBeGreaterThan(0);
			}

			expect(startRequest.body).toMatchObject({
				tool_name: "Bash",
				tool_input_summary: "npm test",
				activity_text: "Using Bash: npm test",
				tool_use_id: "call-1",
			});
			expect(endRequest.body).toMatchObject({
				tool_name: "Bash",
				tool_input_summary: "npm test",
				activity_text: "Completed Bash: npm test",
				tool_use_id: "call-1",
			});
		} finally {
			await httpServer.close();
			if (originalEnv.url === undefined) delete process.env[QUARTERDECK_PI_HOOK_HTTP_URL_ENV];
			else process.env[QUARTERDECK_PI_HOOK_HTTP_URL_ENV] = originalEnv.url;
			if (originalEnv.token === undefined) delete process.env[QUARTERDECK_HOOK_HTTP_TOKEN_ENV];
			else process.env[QUARTERDECK_HOOK_HTTP_TOKEN_ENV] = originalEnv.token;
			if (originalEnv.taskId === undefined) delete process.env[QUARTERDECK_HOOK_TASK_ID_ENV];
			else process.env[QUARTERDECK_HOOK_TASK_ID_ENV] = originalEnv.taskId;
			if (originalEnv.projectId === undefined) delete process.env[QUARTERDECK_HOOK_PROJECT_ID_ENV];
			else process.env[QUARTERDECK_HOOK_PROJECT_ID_ENV] = originalEnv.projectId;
			if (originalEnv.sessionInstanceId === undefined) delete process.env[QUARTERDECK_HOOK_SESSION_INSTANCE_ID_ENV];
			else process.env[QUARTERDECK_HOOK_SESSION_INSTANCE_ID_ENV] = originalEnv.sessionInstanceId;
		}
	});

	it("falls back to spawning `hooks notify` for best-effort hooks without a published HTTP URL env", async () => {
		expect(process.env[QUARTERDECK_PI_HOOK_HTTP_URL_ENV]).toBeUndefined();

		const calls = await captureLifecycleHooks((handlers, context) => {
			handlers.get("tool_execution_start")?.(
				{ toolName: "Bash", toolCallId: "call-1", args: { command: "npm test" } },
				context,
			);
		}, 1);

		expect(flagValue(calls[0] ?? [], "--hook-event-name")).toBe("ToolExecutionStart");
		expect(flagValue(calls[0] ?? [], "--tool-name")).toBe("Bash");
	});
});
