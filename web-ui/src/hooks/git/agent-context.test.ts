import { TASK_QUICK_REPLY_MAX_LENGTH } from "@runtime-contract";
import { describe, expect, it } from "vitest";
import type { SourceEditorActionContext } from "@/components/editor/source-editor-context";
import { buildUnifiedDiffRows } from "@/components/shared/diff-parser";
import { buildAgentContextPrompt, captureDiffAgentContext, captureEditorAgentContext } from "./agent-context";

const editor: SourceEditorActionContext = {
	path: "src/draft.ts",
	content: "const changed = 2;\r\n",
	documentVersion: 5,
	position: { line: 0, character: 15 },
	selection: {
		from: 6,
		to: 15,
		text: "changed =",
		range: { start: { line: 0, character: 6 }, end: { line: 0, character: 15 } },
	},
};

describe("agent context capture", () => {
	it("captures the exact unsaved selection and exclusive range", () => {
		expect(captureEditorAgentContext(editor, "selection")).toEqual({
			kind: "selection",
			path: "src/draft.ts",
			location: "Editor buffer 1:7–1:16 (end exclusive; may include unsaved changes)",
			content: "changed =",
		});
		expect(
			captureEditorAgentContext({ ...editor, selection: { ...editor.selection, to: 6 } }, "selection"),
		).toBeNull();
	});

	it("captures the complete buffer without trimming or changing line endings", () => {
		expect(captureEditorAgentContext(editor, "file")?.content).toBe(editor.content);
	});

	it("captures a diff hunk including exact change prefixes and line provenance", () => {
		const rows = buildUnifiedDiffRows("before\nold\nafter\n", "before\nnew\nafter\n");
		expect(captureDiffAgentContext("example.txt", rows)).toEqual({
			kind: "diff hunk",
			path: "example.txt",
			location: "Old line 2; new line 2",
			content: " before\n-old\n+new\n after",
		});
		expect(
			captureDiffAgentContext(
				"example.txt",
				rows.filter((row) => row.variant === "context"),
			),
		).toBeNull();
	});

	it.each([
		{ variant: "added" as const, lineNumber: 4, location: "new line 4", prefix: "+" },
		{ variant: "removed" as const, lineNumber: 4, location: "Old line 4", prefix: "-" },
		{ variant: "added" as const, lineNumber: null, location: "", prefix: "+" },
		{ variant: "removed" as const, lineNumber: null, location: "", prefix: "-" },
	])("captures an $variant-only hunk with line number $lineNumber", ({ variant, lineNumber, location, prefix }) => {
		expect(captureDiffAgentContext("example.txt", [{ key: "change", variant, lineNumber, text: "changed" }])).toEqual(
			{
				kind: "diff hunk",
				path: "example.txt",
				location,
				content: `${prefix}changed`,
			},
		);
	});

	it("includes instruction, source and exact context in the shared prompt budget", () => {
		const context = captureEditorAgentContext(editor, "file")!;
		const prompt = buildAgentContextPrompt(context, "Explain this change.", "Branch/ref feature");
		expect(prompt.error).toBeNull();
		expect(prompt.text).toContain("Request: Explain this change.");
		expect(prompt.text).toContain("Source: Branch/ref feature");
		expect(prompt.text).toContain(editor.content);
		const overhead = buildAgentContextPrompt({ ...context, content: "" }, "Ask", "Task worktree").text.length;
		const exact = { ...context, content: "x".repeat(TASK_QUICK_REPLY_MAX_LENGTH - overhead) };
		expect(buildAgentContextPrompt(exact, "Ask", "Task worktree").error).toBeNull();
		const tooLong = buildAgentContextPrompt(exact, "Ask!", "Task worktree");
		expect(tooLong.error).toContain("Select a smaller range");
		expect(tooLong.text).toContain(exact.content);
		expect(buildAgentContextPrompt(context, "  ", "Task worktree").error).toContain("Add an instruction");
	});
});
