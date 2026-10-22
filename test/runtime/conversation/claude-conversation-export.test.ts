import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
	exportClaudeConversation,
	resolveClaudeTaskProfileRoot,
} from "../../../src/conversation/claude-conversation-export.js";
import { createTempDir } from "../../utilities/temp-dir.js";

const SESSION_ID = "claude-session-fixture";
const temporaryDirectories: Array<ReturnType<typeof createTempDir>> = [];

afterEach(async () => {
	await Promise.all(temporaryDirectories.splice(0).map((directory) => directory.cleanupAsync()));
});

async function writeSession(content: string, sessionId = SESSION_ID) {
	const directory = createTempDir("claude-export-");
	temporaryDirectories.push(directory);
	const projectDirectory = join(directory.path, "projects", "-repo");
	await mkdir(projectDirectory, { recursive: true });
	const sourcePath = join(projectDirectory, `${sessionId}.jsonl`);
	await writeFile(sourcePath, content, "utf8");
	return { profileRoot: directory.path, sourcePath };
}

function line(record: Record<string, unknown>): string {
	return `${JSON.stringify({ sessionId: SESSION_ID, ...record })}\n`;
}

function message(uuid: string, parentUuid: string | null, role: "user" | "assistant", text: string): string {
	return line({ type: role, uuid, parentUuid, message: { role, content: [{ type: "text", text }] } });
}

describe("Claude conversation export", () => {
	it("copies the exact session's prompts and replies without tool output or metadata", async () => {
		const fixture = await readFile(resolve("test/fixtures/conversation/claude/normal.jsonl"), "utf8");
		const { profileRoot } = await writeSession(
			`${fixture}${line({ type: "custom-title", customTitle: "Renamed", uuid: "title-entry" })}`,
		);
		await expect(exportClaudeConversation({ profileRoot, sessionId: SESSION_ID, hint: null })).resolves.toBe(
			[
				"## You\n\nInspect the failing test.",
				"## Claude\n\nThe assertion uses the wrong expected value.",
				"## You\n\nPlease correct it.",
				"## Claude\n\nFixed and the focused test now passes.\n",
			].join("\n\n"),
		);
	});

	it("follows the active branch and bridges compactions with a marker", async () => {
		const { profileRoot, sourcePath } = await writeSession(
			[
				message("u1", null, "user", "First prompt"),
				message("a1", "u1", "assistant", "First reply"),
				message("u-rewound", "a1", "user", "Abandoned prompt"),
				message("u2", "a1", "user", "Second prompt"),
				message("a2", "u2", "assistant", "Second reply"),
				line({
					type: "system",
					subtype: "compact_boundary",
					uuid: "compact",
					parentUuid: null,
					logicalParentUuid: "a2",
				}),
				line({
					type: "user",
					uuid: "summary",
					parentUuid: "compact",
					isCompactSummary: true,
					message: { role: "user", content: "Summary of earlier work" },
				}),
				message("u3", "summary", "user", "After compaction"),
				message("a3", "u3", "assistant", "Latest reply"),
				// Metadata with a uuid but no parent must not become the active leaf.
				line({ type: "custom-title", customTitle: "Renamed", uuid: "title-entry" }),
				// Unterminated final record is still being written.
				JSON.stringify({ type: "assistant", uuid: "partial" }),
			].join(""),
		);
		const text = await exportClaudeConversation({
			profileRoot,
			sessionId: SESSION_ID,
			hint: { providerId: "claude", providerSessionId: SESSION_ID, sourcePath },
		});
		expect(text).toBe(
			[
				"## You\n\nFirst prompt",
				"## Claude\n\nFirst reply",
				"## You\n\nSecond prompt",
				"## Claude\n\nSecond reply",
				"[Context compacted]",
				"## You\n\nAfter compaction",
				"## Claude\n\nLatest reply\n",
			].join("\n\n"),
		);
		expect(text).not.toContain("Abandoned prompt");
		expect(text).not.toContain("Summary of earlier work");
	});

	it.each([
		["a missing transcript", null, "No saved Claude conversation is available yet."],
		[
			"another session's records",
			line({
				type: "user",
				uuid: "u1",
				parentUuid: null,
				sessionId: "other",
				message: { role: "user", content: "x" },
			}),
			"belongs to a different session",
		],
		[
			"an unreadable record newer than the leaf",
			`${message("u1", null, "user", "Prompt")}{not json}\n`,
			"unreadable",
		],
		[
			"an unreadable record in an unlinked legacy file",
			'{not json}\n{"type":"user","sessionId":"x"}\n',
			"unreadable",
		],
		[
			"an unreadable active ancestor",
			`${message("u1", null, "user", "Prompt")}{"uuid":"a1",\n${message("u2", "a1", "user", "Next")}`,
			"unreadable",
		],
		["a broken parent chain", message("a1", "missing", "assistant", "Reply"), "could not be linked"],
		["no messages", line({ type: "system", subtype: "session_start", uuid: "start" }), "No saved messages"],
	])("fails explicitly for %s", async (_name, content, error) => {
		const { profileRoot } = await writeSession(content ?? "", content === null ? "unrelated" : SESSION_ID);
		await expect(exportClaudeConversation({ profileRoot, sessionId: SESSION_ID, hint: null })).rejects.toThrow(error);
	});

	it("skips unreadable records that are provably off the active chain", async () => {
		const { profileRoot } = await writeSession(
			[
				message("u1", null, "user", "Prompt"),
				"{not json}\n",
				line({ type: "user", uuid: "bad", parentUuid: "u1", message: "not an object" }),
				message("a1", "u1", "assistant", "Reply"),
			].join(""),
		);
		await expect(exportClaudeConversation({ profileRoot, sessionId: SESSION_ID, hint: null })).resolves.toBe(
			"## You\n\nPrompt\n\n## Claude\n\nReply\n",
		);
	});

	it("enforces the 8 MB copy limit", async () => {
		const large = "x".repeat(1024 * 1024);
		const records = Array.from({ length: 9 }, (_, index) =>
			message(`m${index}`, index ? `m${index - 1}` : null, index % 2 ? "assistant" : "user", large),
		);
		const { profileRoot } = await writeSession(records.join(""));
		await expect(exportClaudeConversation({ profileRoot, sessionId: SESSION_ID, hint: null })).rejects.toThrow(
			"8 MB copy limit",
		);
	});

	it("resolves the task's launch profile root", () => {
		expect(resolveClaudeTaskProfileRoot("/work/tree", { CLAUDE_CONFIG_DIR: "profile", HOME: "/home/u" })).toBe(
			resolve("/work/tree", "profile"),
		);
		expect(resolveClaudeTaskProfileRoot("/work/tree", { HOME: "/home/u" })).toBe(resolve("/home/u/.claude"));
	});
});
