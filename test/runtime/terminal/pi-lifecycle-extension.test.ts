import { describe, expect, it } from "vitest";

import { buildPiLifecycleExtensionSource } from "../../../src/terminal/pi-lifecycle-extension";

function listenerBlock(source: string, eventName: string): string {
	const start = source.indexOf(`pi.on("${eventName}"`);
	expect(start).toBeGreaterThanOrEqual(0);
	const next = source.indexOf("\n\tpi.on(", start + 1);
	return next === -1 ? source.slice(start) : source.slice(start, next);
}

describe("Pi lifecycle extension source", () => {
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
