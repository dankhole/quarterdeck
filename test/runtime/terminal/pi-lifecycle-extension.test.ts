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
	QUARTERDECK_PI_TOOL_APPROVALS_ENV,
} from "../../../src/terminal/pi-lifecycle-extension";

const HOOK_COMMAND_ENV_PLACEHOLDER = "__QUARTERDECK_PI_HOOK_COMMAND_ENV__";
const TOOL_APPROVALS_ENV_PLACEHOLDER = "__QUARTERDECK_PI_TOOL_APPROVALS_ENV__";
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

interface PiToolInfoHarness {
	name: string;
	sourceInfo?: {
		source?: string;
	};
}

interface PiExtensionContextHarness {
	hasUI: boolean;
	ui: {
		confirm(title: string, question: string): Promise<boolean>;
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
	getAllTools(): PiToolInfoHarness[];
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

describe("Pi lifecycle extension source", () => {
	it("emits the runtime asset with only the launch environment placeholders substituted", () => {
		const assetSource = readPiLifecycleRuntimeAsset();
		const source = buildPiLifecycleExtensionSource();

		expect(assetSource.split(HOOK_COMMAND_ENV_PLACEHOLDER)).toHaveLength(2);
		expect(assetSource.split(TOOL_APPROVALS_ENV_PLACEHOLDER)).toHaveLength(2);
		expect(assetSource).not.toContain(QUARTERDECK_PI_HOOK_COMMAND_ENV);
		expect(source).toBe(
			assetSource
				.replace(HOOK_COMMAND_ENV_PLACEHOLDER, QUARTERDECK_PI_HOOK_COMMAND_ENV)
				.replace(TOOL_APPROVALS_ENV_PLACEHOLDER, QUARTERDECK_PI_TOOL_APPROVALS_ENV),
		);
		expect(source).toContain(`const HOOK_COMMAND_ENV = "${QUARTERDECK_PI_HOOK_COMMAND_ENV}";`);
		expect(source).toContain(`const TOOL_APPROVALS_ENV = "${QUARTERDECK_PI_TOOL_APPROVALS_ENV}";`);
		expect(source).not.toContain(HOOK_COMMAND_ENV_PLACEHOLDER);
		expect(source).not.toContain(TOOL_APPROVALS_ENV_PLACEHOLDER);
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
			"project_trust",
			"session_start",
			"session_before_switch",
			"session_before_fork",
			"input",
			"agent_start",
			"agent_end",
			"agent_settled",
			"tool_execution_start",
			"tool_execution_update",
			"tool_execution_end",
			"tool_call",
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
		expect(listenerBlock(source, "input")).toMatch(/enqueueDurableHook\(\s*"to_in_progress"/);
		expect(listenerBlock(source, "agent_start")).toMatch(/enqueueDurableHook\(\s*"to_in_progress"/);
		expect(listenerBlock(source, "agent_end")).toMatch(/enqueueDurableHook\(\s*"activity"/);
		expect(listenerBlock(source, "agent_settled")).toMatch(/enqueueDurableHook\(\s*"to_review"/);
		expect(listenerBlock(source, "agent_settled")).toMatch(/hookEventName: "AgentSettled"/);
	});

	it("freezes each queued hook to the run identity active when it was enqueued", async () => {
		const initialize = await loadPiLifecycleExtension();
		const handlers = new Map<string, PiEventHandlerHarness>();
		initialize({
			on: (eventName, handler) => handlers.set(eventName, handler),
			getAllTools: () => [],
		});
		const input = handlers.get("input");
		const agentStart = handlers.get("agent_start");
		expect(input).toBeDefined();
		expect(agentStart).toBeDefined();

		const tempDir = await mkdtemp(join(tmpdir(), "quarterdeck-pi-hook-order-"));
		const helperPath = join(tempDir, "capture-hook.mjs");
		const outputPath = join(tempDir, "hooks.jsonl");
		await writeFile(
			helperPath,
			'import { appendFileSync } from "node:fs";\nappendFileSync(process.env.QD_TEST_PI_HOOK_OUTPUT, JSON.stringify(process.argv.slice(2)) + "\\n");\n',
			"utf8",
		);
		const context: PiExtensionContextHarness = {
			hasUI: true,
			ui: { confirm: vi.fn(async () => true), notify: vi.fn() },
			sessionManager: { getSessionId: () => "pi-session-1" },
		};
		const originalHookCommand = process.env[QUARTERDECK_PI_HOOK_COMMAND_ENV];
		const originalOutputPath = process.env.QD_TEST_PI_HOOK_OUTPUT;
		process.env[QUARTERDECK_PI_HOOK_COMMAND_ENV] = JSON.stringify([process.execPath, helperPath, "notify"]);
		process.env.QD_TEST_PI_HOOK_OUTPUT = outputPath;
		try {
			input?.({}, context);
			agentStart?.({}, context);
			agentStart?.({}, context);

			await vi.waitFor(
				async () => {
					const lines = (await readFile(outputPath, "utf8")).trim().split("\n");
					expect(lines).toHaveLength(3);
				},
				{ timeout: 5_000 },
			);
			const calls = (await readFile(outputPath, "utf8"))
				.trim()
				.split("\n")
				.map((line) => JSON.parse(line) as string[]);
			expect(calls[0]).not.toContain("--turn-id");
			const turnIds = calls.slice(1).map((args) => args[args.indexOf("--turn-id") + 1]);
			expect(turnIds).toEqual([expect.any(String), expect.any(String)]);
			expect(turnIds[0]).not.toBe(turnIds[1]);
		} finally {
			if (originalHookCommand === undefined) {
				delete process.env[QUARTERDECK_PI_HOOK_COMMAND_ENV];
			} else {
				process.env[QUARTERDECK_PI_HOOK_COMMAND_ENV] = originalHookCommand;
			}
			if (originalOutputPath === undefined) {
				delete process.env.QD_TEST_PI_HOOK_OUTPUT;
			} else {
				process.env.QD_TEST_PI_HOOK_OUTPUT = originalOutputPath;
			}
			await rm(tempDir, { recursive: true, force: true });
		}
	});

	it("awaits permission request and resolution hooks in order", () => {
		const source = buildPiLifecycleExtensionSource();
		const block = listenerBlock(source, "tool_call");

		expect(block).toMatch(/await enqueueDurableHook\(\s*"to_review"/);
		expect(block).toMatch(/hookEventName: "PermissionRequest"/);
		expect(block).toMatch(/await enqueueDurableHook\(\s*"to_in_progress"/);
		expect(block).toMatch(/hookEventName: "PermissionResolved"/);
		expect(block).toMatch(/hookEventName: "PermissionDenied"/);
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

	it("bypasses approval only for read-only tools verified as Pi built-ins", () => {
		const source = buildPiLifecycleExtensionSource();
		const block = listenerBlock(source, "tool_call");

		expect(source).toContain('new Set(["read", "grep", "find", "ls"])');
		expect(source).toContain("function isVerifiedBuiltInReadOnlyTool");
		expect(source).toContain('tool.sourceInfo?.source === "builtin"');
		expect(block).toContain("!areToolApprovalsEnabled() || isVerifiedBuiltInReadOnlyTool(pi, event.toolName)");
		expect(block).toContain('return { block: true, reason: "Blocked by user" };');
	});

	it("prompts for an extension that overrides a read-only built-in name", async () => {
		const initialize = await loadPiLifecycleExtension();
		const handlers = new Map<string, PiEventHandlerHarness>();
		let toolSource = "builtin";
		const pi: PiExtensionApiHarness = {
			on: (eventName, handler) => handlers.set(eventName, handler),
			getAllTools: () => [{ name: "read", sourceInfo: { source: toolSource } }],
		};
		initialize(pi);
		const toolCall = handlers.get("tool_call");
		expect(toolCall).toBeDefined();

		const confirm = vi.fn(async () => false);
		const context: PiExtensionContextHarness = {
			hasUI: true,
			ui: { confirm, notify: vi.fn() },
			sessionManager: { getSessionId: () => "pi-session-1" },
		};
		const originalHookCommand = process.env[QUARTERDECK_PI_HOOK_COMMAND_ENV];
		delete process.env[QUARTERDECK_PI_HOOK_COMMAND_ENV];
		try {
			const builtInResult = await toolCall?.(
				{ toolName: "read", toolCallId: "built-in-read", input: { path: "README.md" } },
				context,
			);
			expect(builtInResult).toBeUndefined();
			expect(confirm).not.toHaveBeenCalled();

			toolSource = "local";
			const overriddenResult = await toolCall?.(
				{ toolName: "read", toolCallId: "overridden-read", input: { path: "README.md" } },
				context,
			);
			expect(overriddenResult).toEqual({ block: true, reason: "Blocked by user" });
			expect(confirm).toHaveBeenCalledOnce();
		} finally {
			if (originalHookCommand === undefined) {
				delete process.env[QUARTERDECK_PI_HOOK_COMMAND_ENV];
			} else {
				process.env[QUARTERDECK_PI_HOOK_COMMAND_ENV] = originalHookCommand;
			}
		}
	});

	it("allows every tool without prompting when launch-scoped approvals are disabled", async () => {
		const initialize = await loadPiLifecycleExtension();
		const handlers = new Map<string, PiEventHandlerHarness>();
		initialize({
			on: (eventName, handler) => handlers.set(eventName, handler),
			getAllTools: () => [],
		});
		const toolCall = handlers.get("tool_call");
		expect(toolCall).toBeDefined();

		const confirm = vi.fn(async () => false);
		const context: PiExtensionContextHarness = {
			hasUI: true,
			ui: { confirm, notify: vi.fn() },
			sessionManager: { getSessionId: () => "pi-session-1" },
		};
		const originalToolApprovals = process.env[QUARTERDECK_PI_TOOL_APPROVALS_ENV];
		process.env[QUARTERDECK_PI_TOOL_APPROVALS_ENV] = "disabled";
		try {
			const result = await toolCall?.(
				{ toolName: "bash", toolCallId: "bash-1", input: { command: "node --version" } },
				context,
			);
			expect(result).toBeUndefined();
			expect(confirm).not.toHaveBeenCalled();
		} finally {
			if (originalToolApprovals === undefined) {
				delete process.env[QUARTERDECK_PI_TOOL_APPROVALS_ENV];
			} else {
				process.env[QUARTERDECK_PI_TOOL_APPROVALS_ENV] = originalToolApprovals;
			}
		}
	});

	it("still requires project trust when tool approvals are disabled", async () => {
		const initialize = await loadPiLifecycleExtension();
		const handlers = new Map<string, PiEventHandlerHarness>();
		initialize({
			on: (eventName, handler) => handlers.set(eventName, handler),
			getAllTools: () => [],
		});
		const projectTrust = handlers.get("project_trust");
		expect(projectTrust).toBeDefined();

		const confirm = vi.fn(async () => true);
		const context: PiExtensionContextHarness = {
			hasUI: true,
			ui: { confirm, notify: vi.fn() },
			sessionManager: { getSessionId: () => "pi-session-1" },
		};
		const originalToolApprovals = process.env[QUARTERDECK_PI_TOOL_APPROVALS_ENV];
		process.env[QUARTERDECK_PI_TOOL_APPROVALS_ENV] = "disabled";
		try {
			const result = await projectTrust?.({ cwd: "/tmp/project" }, context);
			expect(result).toEqual({ trusted: "yes", remember: false });
			expect(confirm).toHaveBeenCalledWith(
				"Pi Permission",
				expect.stringContaining("Trust this project for this Pi session?"),
			);
		} finally {
			if (originalToolApprovals === undefined) {
				delete process.env[QUARTERDECK_PI_TOOL_APPROVALS_ENV];
			} else {
				process.env[QUARTERDECK_PI_TOOL_APPROVALS_ENV] = originalToolApprovals;
			}
		}
	});
});
