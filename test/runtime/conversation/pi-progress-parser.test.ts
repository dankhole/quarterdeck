import { describe, expect, it } from "vitest";
import { parsePiProgressEntry } from "../../../src/conversation/pi-progress-parser";

const entry = (message: unknown) => ({
	type: "message",
	id: "a",
	parentId: "u",
	timestamp: new Date(200).toISOString(),
	message,
});
const assistant = (content: unknown) => ({ role: "assistant", timestamp: 200, content });

describe("Pi progress record parser", () => {
	it("extracts only direct assistant text and preserves Markdown", () => {
		expect(
			parsePiProgressEntry(
				entry(
					assistant([
						{ type: "thinking", thinking: "private" },
						{ type: "thinking", redacted: true, thinkingSignature: "encrypted" },
						{ type: "text", text: "First\n  indented" },
						{ type: "toolCall", id: "t", name: "subagent", arguments: { text: "child response" } },
						{ type: "text", text: "Second" },
					]),
				),
			),
		).toMatchObject({ text: "First\n  indented\n\nSecond", recordedAt: 200 });
	});
	it.each(["user", "toolResult", "system", "bashExecution", "custom", "branchSummary", "compactionSummary"])(
		"does not expose %s content",
		(role) => {
			expect(
				parsePiProgressEntry(
					entry({
						role,
						content: [{ type: "text", text: "not foreground" }],
						details: { messages: [assistant([{ type: "text", text: "child" }])] },
					}),
				)?.text,
			).toBeNull();
		},
	);
	it.each([
		null,
		{ ...entry(assistant([])), id: "" },
		{ ...entry(assistant([])), parentId: "a" },
		{ ...entry(assistant([])), parentId: undefined },
		{ ...entry(assistant([])), timestamp: "invalid" },
		{ ...entry(assistant([])), type: "future_type" },
		entry(assistant("not a content array")),
		entry(
			assistant([
				{ type: "text", text: "safe" },
				{ type: "unknown", text: "unsafe" },
			]),
		),
		entry(assistant([{ type: "text", text: 42 }])),
		entry({ ...assistant([{ type: "text", text: "partial" }]), stopReason: "pending" }),
		entry({ ...assistant([]), timestamp: "200" }),
		{ ...entry(null), type: "context_edit", targetId: null, replacement: null },
	])("rejects malformed or ambiguous record %#", (record) => {
		expect(parsePiProgressEntry(record)).toBeNull();
	});
	it.each(["custom", "custom_message", "usage", "label", "session_info"])("ignores %s extension metadata", (type) => {
		expect(parsePiProgressEntry({ ...entry(null), type, content: "child reply" })?.text).toBeNull();
	});
	it.each(["error", "aborted"])("excludes %s assistant responses", (stopReason) => {
		expect(
			parsePiProgressEntry(entry({ ...assistant([{ type: "text", text: "Do not publish" }]), stopReason })),
		).toMatchObject({ text: null, invalidatesPreview: true });
	});
	it("identifies a context edit without exposing replacement content", () => {
		expect(
			parsePiProgressEntry({
				...entry(null),
				type: "context_edit",
				targetId: "previous",
				replacement: { content: "not a new assistant reply" },
			}),
		).toMatchObject({ text: null, editedEntryId: "previous" });
	});
	it.each(["compaction", "branch_summary"])("identifies %s as an ambiguity boundary", (type) => {
		expect(parsePiProgressEntry({ ...entry(null), type, summary: "not assistant text" })).toMatchObject({
			text: null,
			boundary: true,
		});
	});
});
