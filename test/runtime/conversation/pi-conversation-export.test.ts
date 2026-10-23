import { mkdir, readFile, realpath, symlink, truncate, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { exportPiConversation } from "../../../src/conversation/pi-conversation-export.js";
import { createTempDir } from "../../utilities/temp-dir.js";

const SESSION_ID = "pi-session-fixture";
const temporaryDirectories: Array<ReturnType<typeof createTempDir>> = [];
afterEach(async () => {
	await Promise.all(temporaryDirectories.splice(0).map((directory) => directory.cleanupAsync()));
});

function line(record: Record<string, unknown>): string {
	return `${JSON.stringify(record)}\n`;
}
function entry(id: string, parentId: string | null, fields: Record<string, unknown>): string {
	return line({ id, parentId, timestamp: "2026-01-01T00:00:00Z", ...fields });
}
function message(id: string, parentId: string | null, role: "user" | "assistant", content: unknown): string {
	return entry(id, parentId, { type: "message", message: { role, content } });
}
function reply(id: string, parentId: string | null, text: string): string {
	return message(id, parentId, "assistant", [{ type: "text", text }]);
}
async function fixture(records: string) {
	const directory = createTempDir("pi-export-");
	temporaryDirectories.push(directory);
	const launchPath = await realpath(directory.path);
	const sessionDirectory = join(launchPath, "custom-session-storage");
	await mkdir(sessionDirectory);
	// Exact hook path need not match an inferred default profile or filename.
	const sourcePath = join(sessionDirectory, "provider-selected.jsonl");
	const header = line({ type: "session", version: 3, id: SESSION_ID, cwd: launchPath });
	await writeFile(sourcePath, header + records);
	return {
		launchPath,
		sourcePath,
		header,
		input: {
			launchPath,
			sessionId: SESSION_ID,
			sessionInstanceId: "launch-1",
			hint: { providerId: "pi" as const, providerSessionId: SESSION_ID, sourcePath, sessionInstanceId: "launch-1" },
		},
	};
}

describe("Pi conversation export", () => {
	it.each(["unwritten.jsonl", "not-created/session.jsonl"])(
		"reports no saved messages when the lazy session path does not exist: %s",
		async (relativePath) => {
			const f = await fixture("");
			await expect(
				exportPiConversation({
					...f.input,
					hint: { ...f.input.hint, sourcePath: join(f.launchPath, relativePath) },
				}),
			).rejects.toThrow("No saved messages are available to copy yet.");
		},
	);

	it("copies all saved active prompts and replies, excluding tools, reasoning, images and metadata, without writes", async () => {
		const records = [
			entry("system", null, { type: "message", message: { role: "system", content: "private system prompt" } }),
			message("u1", "system", "user", [
				{ type: "text", text: "Inspect this" },
				{ type: "image", mimeType: "image/png", data: "private-image" },
			]),
			message("a1", "u1", "assistant", [
				{ type: "thinking", thinking: "private reasoning" },
				{ type: "text", text: "First reply" },
				{ type: "toolCall", id: "call", name: "bash", arguments: { command: "private command" } },
			]),
			entry("tool", "a1", {
				type: "message",
				message: { role: "toolResult", content: [{ type: "text", text: "private output" }] },
			}),
			entry("custom", "tool", { type: "custom_message", content: "injected extension context", display: false }),
			message("u2", "custom", "user", "Next prompt"),
			reply("a2", "u2", "Final reply"),
			entry("name", "a2", { type: "session_info", name: "Renamed" }),
		].join("");
		const f = await fixture(records);
		await expect(exportPiConversation(f.input)).resolves.toBe(
			"## You\n\nInspect this\n\n## Pi\n\nFirst reply\n\n## You\n\nNext prompt\n\n## Pi\n\nFinal reply\n",
		);
		expect(await readFile(f.sourcePath, "utf8")).toBe(f.header + records);
	});

	it("walks the saved leaf's lineage across multiple compactions, not the context-retained range or abandoned branch", async () => {
		const f = await fixture(
			[
				message("u1", null, "user", "Oldest prompt"),
				reply("a1", "u1", "Oldest reply"),
				message("abandoned", "a1", "user", "Abandoned prompt"),
				reply("abandoned-reply", "abandoned", "Abandoned reply"),
				entry("branch", "a1", {
					type: "branch_summary",
					fromId: "abandoned-reply",
					summary: "Do not substitute a branch summary",
				}),
				message("u2", "branch", "user", "Active prompt"),
				reply("a2", "u2", "Active reply"),
				entry("compact", "a2", {
					type: "compaction",
					firstKeptEntryId: "a2",
					summary: "Do not substitute compaction summaries",
				}),
				entry("edit", "compact", { type: "context_edit", targetId: "u1", replacement: null }),
				message("u3", "edit", "user", "After compaction"),
				entry("compact2", "u3", { type: "compaction", firstKeptEntryId: "compact2", summary: "Another summary" }),
				reply("a3", "compact2", "Newest reply"),
			].join(""),
		);
		await expect(exportPiConversation(f.input)).resolves.toBe(
			[
				"## You\n\nOldest prompt",
				"## Pi\n\nOldest reply",
				"[Branch changed]",
				"## You\n\nActive prompt",
				"## Pi\n\nActive reply",
				"[Context compacted]",
				"## You\n\nAfter compaction",
				"[Context compacted]",
				"## Pi\n\nNewest reply\n",
			].join("\n\n"),
		);
	});

	it("uses the last saved root after resetLeaf rather than copying every root", async () => {
		const f = await fixture(message("old", null, "user", "Old branch") + message("new", null, "user", "New branch"));
		await expect(exportPiConversation(f.input)).resolves.toBe("## You\n\nNew branch\n");
	});

	it.each([
		["invalid JSON", "{bad json}\n", "unreadable"],
		["unterminated record", '{"type":"message"}', "unreadable"],
		["missing parent", reply("a", "missing", "Reply"), "could not be linked"],
		["self cycle", reply("a", "a", "Reply"), "could not be linked"],
		["duplicate ID", message("u", null, "user", "Prompt") + reply("u", "u", "Reply"), "could not be linked"],
		["malformed message", message("u", null, "user", [{ type: "text", text: 42 }]), "unreadable"],
		["unknown content", message("u", null, "user", [{ type: "unknown" }]), "unreadable"],
		["second header", line({ type: "session", version: 3, id: "foreign", cwd: "/other" }), "could not be linked"],
		["no messages", entry("meta", null, { type: "session_info", name: "Name" }), "No saved messages"],
	])("fails closed for %s", async (_name, records, error) => {
		const f = await fixture(records);
		await expect(exportPiConversation(f.input)).rejects.toThrow(error);
	});

	it.each([{ id: "foreign" }, { cwd: "/foreign" }, { version: 1 }, { version: 2 }, { version: 4 }])(
		"rejects a foreign or unsupported header %j",
		async (override) => {
			const f = await fixture("");
			await writeFile(
				f.sourcePath,
				line({ type: "session", version: 3, id: SESSION_ID, cwd: f.launchPath, ...override }) +
					message("u", null, "user", "Prompt"),
			);
			await expect(exportPiConversation(f.input)).rejects.toThrow("not valid");
		},
	);

	it("requires the exact current-launch hint and does not look up another/latest session", async () => {
		const f = await fixture(message("u", null, "user", "Prompt"));
		for (const hint of [
			null,
			{ ...f.input.hint, sessionInstanceId: "old" },
			{ ...f.input.hint, providerSessionId: "foreign" },
			{ ...f.input.hint, providerId: "claude" as const },
		]) {
			await expect(exportPiConversation({ ...f.input, hint })).rejects.toThrow(
				"source is available for this launch",
			);
		}
	});

	it("rejects symlink escapes and non-regular files", async () => {
		const f = await fixture(message("u", null, "user", "Prompt"));
		const outside = join(f.launchPath, "outside.jsonl");
		await writeFile(outside, await readFile(f.sourcePath));
		const link = join(f.launchPath, "custom-session-storage", "link.jsonl");
		await symlink(outside, link);
		for (const sourcePath of [link, join(f.launchPath, "custom-session-storage"), "relative.jsonl"]) {
			await expect(exportPiConversation({ ...f.input, hint: { ...f.input.hint, sourcePath } })).rejects.toThrow(
				"not valid",
			);
		}
	});

	it("bounds source size before reading", async () => {
		const f = await fixture("");
		await truncate(f.sourcePath, 128 * 1024 * 1024 + 1);
		await expect(exportPiConversation(f.input)).rejects.toThrow("128 MB history read limit");
	});
	it("bounds raw record size", async () => {
		const f = await fixture(message("u", null, "user", "x".repeat(16 * 1024 * 1024)));
		await expect(exportPiConversation(f.input)).rejects.toThrow("16 MB record limit");
	});
	it("bounds copied UTF-8 output", async () => {
		const f = await fixture(message("u", null, "user", "é".repeat(4 * 1024 * 1024)));
		await expect(exportPiConversation(f.input)).rejects.toThrow("8 MB copy limit");
	});
});
