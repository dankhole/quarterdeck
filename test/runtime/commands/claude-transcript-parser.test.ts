import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { extractLastAssistantMessage } from "../../../src/commands/claude-transcript-parser";

function createTempDir(): { path: string; cleanup: () => void } {
	const { mkdtempSync } = require("node:fs");
	const { tmpdir } = require("node:os");
	const dir = mkdtempSync(join(tmpdir(), "qd-transcript-test-"));
	return {
		path: dir,
		cleanup: () => {
			try {
				const { rmSync } = require("node:fs");
				rmSync(dir, { recursive: true, force: true });
			} catch {
				// best-effort cleanup
			}
		},
	};
}

function writeTranscript(dir: string, lines: object[]): string {
	const filePath = join(dir, "transcript.jsonl");
	writeFileSync(filePath, lines.map((l) => JSON.stringify(l)).join("\n"), "utf8");
	return filePath;
}

function assistantMessage(text: string, extraContent?: object[]): object {
	return {
		type: "assistant",
		message: {
			role: "assistant",
			content: [{ type: "text", text }, ...(extraContent ?? [])],
		},
	};
}

function toolUseMessage(preamble: string): object {
	return {
		type: "assistant",
		message: {
			role: "assistant",
			content: [
				{ type: "text", text: preamble },
				{ type: "tool_use", id: "tool-1", name: "Read", input: {} },
			],
		},
	};
}

describe("extractLastAssistantMessage", () => {
	let tempDir: { path: string; cleanup: () => void };

	afterEach(() => {
		tempDir?.cleanup();
	});

	it("extracts the last meaningful assistant message", async () => {
		tempDir = createTempDir();
		const filePath = writeTranscript(tempDir.path, [
			assistantMessage("First message about the code"),
			assistantMessage("I've completed all the requested changes and tests pass"),
		]);

		const result = await extractLastAssistantMessage(filePath);
		expect(result).toBe("I've completed all the requested changes and tests pass");
	});

	it("skips tool use preambles under 30 chars", async () => {
		tempDir = createTempDir();
		const filePath = writeTranscript(tempDir.path, [
			assistantMessage("This is the real meaningful message about the implementation"),
			toolUseMessage("I'll read that file"),
		]);

		const result = await extractLastAssistantMessage(filePath);
		expect(result).toBe("This is the real meaningful message about the implementation");
	});

	it("keeps tool use messages with text >= 30 chars", async () => {
		tempDir = createTempDir();
		const longPreamble = "Let me read through that file and analyze the authentication flow in detail";
		const filePath = writeTranscript(tempDir.path, [
			assistantMessage("Earlier message"),
			{
				type: "assistant",
				message: {
					role: "assistant",
					content: [
						{ type: "text", text: longPreamble },
						{ type: "tool_use", id: "tool-1", name: "Read", input: {} },
					],
				},
			},
		]);

		const result = await extractLastAssistantMessage(filePath);
		expect(result).toBe(longPreamble);
	});

	it("caps output at 500 chars with ellipsis", async () => {
		tempDir = createTempDir();
		const longText = "A".repeat(600);
		const filePath = writeTranscript(tempDir.path, [assistantMessage(longText)]);

		const result = await extractLastAssistantMessage(filePath);
		expect(result).not.toBeNull();
		expect(result?.length).toBe(501); // 500 + ellipsis
		expect(result?.endsWith("\u2026")).toBe(true);
	});

	it("returns null for a non-existent file", async () => {
		const result = await extractLastAssistantMessage("/nonexistent/file.jsonl");
		expect(result).toBeNull();
	});

	it("returns null when no assistant messages exist", async () => {
		tempDir = createTempDir();
		const filePath = writeTranscript(tempDir.path, [
			{ type: "user", message: { role: "user", content: "Hello" } },
			{ type: "tool_result", content: "Some result" },
		]);

		const result = await extractLastAssistantMessage(filePath);
		expect(result).toBeNull();
	});

	it("handles malformed JSON lines gracefully", async () => {
		tempDir = createTempDir();
		const filePath = join(tempDir.path, "transcript.jsonl");
		const lines = ["not valid json", JSON.stringify(assistantMessage("Valid message after bad line"))];
		writeFileSync(filePath, lines.join("\n"), "utf8");

		const result = await extractLastAssistantMessage(filePath);
		expect(result).toBe("Valid message after bad line");
	});

	it("skips assistant messages with no text content", async () => {
		tempDir = createTempDir();
		const filePath = writeTranscript(tempDir.path, [
			assistantMessage("The meaningful one"),
			{
				type: "assistant",
				message: {
					role: "assistant",
					content: [{ type: "tool_use", id: "tool-1", name: "Read", input: {} }],
				},
			},
		]);

		const result = await extractLastAssistantMessage(filePath);
		expect(result).toBe("The meaningful one");
	});

	it("handles string content format", async () => {
		tempDir = createTempDir();
		const filePath = writeTranscript(tempDir.path, [
			{
				type: "assistant",
				message: {
					role: "assistant",
					content: "Plain string content",
				},
			},
		]);

		const result = await extractLastAssistantMessage(filePath);
		expect(result).toBe("Plain string content");
	});

	it("extracts from the tail when earlier transcript content exceeds the tail byte limit", async () => {
		tempDir = createTempDir();
		const filePath = join(tempDir.path, "transcript.jsonl");
		writeFileSync(
			filePath,
			[
				JSON.stringify(assistantMessage(`Earlier oversized message ${"x".repeat(1024 * 1024 + 32)}`)),
				JSON.stringify(assistantMessage("Final meaningful response after a huge earlier transcript entry")),
			].join("\n"),
			"utf8",
		);

		const result = await extractLastAssistantMessage(filePath);
		expect(result).toBe("Final meaningful response after a huge earlier transcript entry");
	});
});
