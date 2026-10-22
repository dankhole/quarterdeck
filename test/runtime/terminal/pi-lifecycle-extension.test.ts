import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { describe, expect, it, vi } from "vitest";

import {
	buildPiLifecycleExtensionSource,
	QUARTERDECK_PI_HOOK_COMMAND_ENV,
} from "../../../src/terminal/pi-lifecycle-extension";

const HOOK_COMMAND_ENV_PLACEHOLDER = "__QUARTERDECK_PI_HOOK_COMMAND_ENV__";
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
	ui: {
		notify(message: string, type?: string): void;
	};
	sessionManager: {
		getSessionId(): string;
	};
}

type PiEventHandlerHarness = (
	event: Record<string, unknown>,
	context: PiExtensionContextHarness,
) => unknown | Promise<unknown>;

interface PiExtensionApiHarness {
	on(eventName: string, handler: PiEventHandlerHarness): void;
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

async function captureLifecycleHooks(
	emit: (handlers: Map<string, PiEventHandlerHarness>, context: PiExtensionContextHarness) => void,
	expectedCount: number,
): Promise<string[][]> {
	const initialize = await loadPiLifecycleExtension();
	const handlers = new Map<string, PiEventHandlerHarness>();
	initialize({ on: (eventName, handler) => handlers.set(eventName, handler) });
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
		sessionManager: { getSessionId: () => "pi-session-1" },
	};
	const originalHookCommand = process.env[QUARTERDECK_PI_HOOK_COMMAND_ENV];
	const originalOutputPath = process.env.QD_TEST_PI_HOOK_OUTPUT;
	process.env[QUARTERDECK_PI_HOOK_COMMAND_ENV] = JSON.stringify([process.execPath, helperPath, "notify"]);
	process.env.QD_TEST_PI_HOOK_OUTPUT = outputPath;
	try {
		emit(handlers, context);
		await vi.waitFor(
			async () => {
				expect((await readFile(outputPath, "utf8")).trim().split("\n")).toHaveLength(expectedCount);
			},
			{ timeout: 5_000 },
		);
		return (await readFile(outputPath, "utf8"))
			.trim()
			.split("\n")
			.map((line) => JSON.parse(line) as string[]);
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
		expect(assetSource).not.toContain(QUARTERDECK_PI_HOOK_COMMAND_ENV);
		expect(source).toBe(assetSource.replace(HOOK_COMMAND_ENV_PLACEHOLDER, QUARTERDECK_PI_HOOK_COMMAND_ENV));
		expect(source).toContain(`const HOOK_COMMAND_ENV = "${QUARTERDECK_PI_HOOK_COMMAND_ENV}";`);
		expect(source).not.toContain(HOOK_COMMAND_ENV_PLACEHOLDER);
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

	it("registers the Pi lifecycle events Quarterdeck maps into hook state", () => {
		const source = buildPiLifecycleExtensionSource();
		const eventNames = [
			"session_start",
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

	it("leaves tool execution and project trust entirely to Pi", async () => {
		const initialize = await loadPiLifecycleExtension();
		const handlers = new Map<string, PiEventHandlerHarness>();
		initialize({ on: (eventName, handler) => handlers.set(eventName, handler) });
		expect(handlers.has("tool_call")).toBe(false);
		expect(handlers.has("project_trust")).toBe(false);
		expect(handlers.has("input")).toBe(false);
		expect(handlers.has("tool_execution_start")).toBe(true);
		expect(handlers.has("agent_settled")).toBe(true);
	});
});
