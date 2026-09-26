import { mkdir, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { CODEX_THREAD_NAME_READ_LIMIT_BYTES, readCodexThreadNames } from "../../src/title/codex-thread-names";
import { createTempDir } from "../utilities/temp-dir";

function entry(id: unknown, threadName: unknown): string {
	return `${JSON.stringify({ id, thread_name: threadName, updated_at: "2026-09-25T00:00:00Z" })}\n`;
}

describe("native Codex thread-name index", () => {
	let sandbox: ReturnType<typeof createTempDir>;
	let indexPath: string;
	beforeEach(() => {
		sandbox = createTempDir("quarterdeck-thread-names-");
		indexPath = join(sandbox.path, "session_index.jsonl");
	});
	afterEach(() => sandbox.cleanup());

	it("returns no names for an absent profile or index", async () => {
		expect(await readCodexThreadNames(join(sandbox.path, "missing"), new Set(["thread"]))).toEqual(new Map());
		expect(await readCodexThreadNames(sandbox.path, new Set(["thread"]))).toEqual(new Map());
	});

	it("selects the latest matching record, normalizes whitespace, and limits title length", async () => {
		await writeFile(
			indexPath,
			entry("first", "Old title") +
				entry("unrelated", "Ignore me") +
				entry("long", "a".repeat(100)) +
				entry("first", "  Latest\n\t title  "),
		);
		expect(await readCodexThreadNames(sandbox.path, new Set(["first", "long", "missing"]))).toEqual(
			new Map([
				["first", "Latest title"],
				["long", "a".repeat(80)],
			]),
		);
	});

	it("ignores malformed records and incomplete trailing writes", async () => {
		await writeFile(
			indexPath,
			entry("thread", "Complete title") +
				"not-json\n" +
				entry(null, "Invalid ID") +
				entry("thread", 23) +
				entry("thread", "bad\u0000title") +
				JSON.stringify({ id: "thread", thread_name: "Unterminated title" }),
		);
		expect(await readCodexThreadNames(sandbox.path, new Set(["thread"]))).toEqual(
			new Map([["thread", "Complete title"]]),
		);
	});

	it.each([null, "", "  \n\t "])("does not resurrect an older name after clearing to %j", async (cleared) => {
		await writeFile(indexPath, entry("thread", "Old title") + entry("thread", cleared));
		expect(await readCodexThreadNames(sandbox.path, new Set(["thread"]))).toEqual(new Map());
	});

	it("reads fresh contents after truncation and replacement", async () => {
		await writeFile(indexPath, entry("thread", "Original title"));
		expect((await readCodexThreadNames(sandbox.path, new Set(["thread"]))).get("thread")).toBe("Original title");
		await writeFile(indexPath, "");
		expect(await readCodexThreadNames(sandbox.path, new Set(["thread"]))).toEqual(new Map());
		await writeFile(indexPath, entry("thread", "New title"));
		expect((await readCodexThreadNames(sandbox.path, new Set(["thread"]))).get("thread")).toBe("New title");
	});

	it("bounds reads to the tail and drops the first cut record", async () => {
		const embedded = entry("partial", "Must not be parsed");
		const tail = embedded + entry("recent", "Recent title");
		const padding = "x".repeat(CODEX_THREAD_NAME_READ_LIMIT_BYTES - tail.length);
		await writeFile(indexPath, `${entry("old", "Outside budget")}x${padding}${tail}`);
		expect(await readCodexThreadNames(sandbox.path, new Set(["old", "partial", "recent"]))).toEqual(
			new Map([["recent", "Recent title"]]),
		);
	});

	it("does not treat nonregular indexes as missing", async () => {
		await mkdir(indexPath);
		await expect(readCodexThreadNames(sandbox.path, new Set(["thread"]))).rejects.toThrow("not_regular_file");
	});

	it.skipIf(process.platform === "win32")("rejects index symlinks", async () => {
		const other = join(sandbox.path, "other.jsonl");
		await writeFile(other, entry("thread", "Do not follow"));
		await symlink(other, indexPath);
		await expect(readCodexThreadNames(sandbox.path, new Set(["thread"]))).rejects.toThrow("not_regular_file");
	});
});
