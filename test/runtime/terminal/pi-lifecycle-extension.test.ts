import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

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

describe("Pi lifecycle extension source", () => {
	it("emits the runtime asset with only the hook command env placeholder substituted", () => {
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
			"input",
			"agent_start",
			"agent_end",
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
		expect(listenerBlock(source, "agent_end")).toMatch(/enqueueDurableHook\(\s*"to_review"/);
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
});
