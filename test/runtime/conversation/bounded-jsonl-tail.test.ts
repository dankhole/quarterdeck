import { open, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";
import { scanJsonlTail } from "../../../src/conversation/bounded-jsonl-tail.js";
import { createTempDir } from "../../utilities/temp-dir.js";

describe("scanJsonlTail", () => {
	let temporaryDirectory: string | null = null;
	let cleanup: (() => void) | null = null;

	afterEach(async () => {
		cleanup?.();
		cleanup = null;
		temporaryDirectory = null;
	});

	it("reads newest records first and stops without examining the full source", async () => {
		({ path: temporaryDirectory, cleanup } = createTempDir("conversation-jsonl-tail-"));
		const sourcePath = join(temporaryDirectory, "history.jsonl");
		const records = Array.from({ length: 200 }, (_, index) => JSON.stringify({ index, text: "x".repeat(200) }));
		await writeFile(sourcePath, `${records.join("\n")}\n`, "utf8");
		const handle = await open(sourcePath, "r");
		const seen: number[] = [];
		try {
			const sourceStat = await handle.stat();
			const result = await scanJsonlTail({
				fileHandle: handle,
				fileSize: sourceStat.size,
				maxBytes: sourceStat.size,
				maxRecords: 4_096,
				maxRawRecordBytes: 1024 * 1024,
				chunkBytes: 512,
				deadlineAt: Date.now() + 2_000,
				onRecord: (record) => {
					if (record.kind === "parsed") {
						seen.push((record.value as { index: number }).index);
					}
					return seen.length < 3;
				},
			});
			expect(seen).toEqual([199, 198, 197]);
			expect(result.bytesExamined).toBeLessThan(sourceStat.size);
			expect(result.stoppedByConsumer).toBe(true);
		} finally {
			await handle.close();
		}
	});

	it("classifies incomplete, malformed, invalid UTF-8, and oversized records", async () => {
		({ path: temporaryDirectory, cleanup } = createTempDir("conversation-jsonl-tail-errors-"));
		const sourcePath = join(temporaryDirectory, "history.jsonl");
		const bytes = Buffer.concat([
			Buffer.from('{"valid":1}\nnot-json\n', "utf8"),
			Buffer.from([0xff, 0xfe, 0x0a]),
			Buffer.from(`{"large":"${"x".repeat(64)}"}\n`, "utf8"),
			Buffer.from('{"partial":', "utf8"),
		]);
		await writeFile(sourcePath, bytes);
		const handle = await open(sourcePath, "r");
		const kinds: string[] = [];
		try {
			const sourceStat = await handle.stat();
			await scanJsonlTail({
				fileHandle: handle,
				fileSize: sourceStat.size,
				maxBytes: sourceStat.size,
				maxRecords: 20,
				maxRawRecordBytes: 32,
				chunkBytes: 17,
				deadlineAt: Date.now() + 2_000,
				onRecord: (record) => {
					kinds.push(record.kind);
					return true;
				},
			});
			expect(kinds).toEqual(["incomplete", "oversized", "invalid_unicode", "malformed", "parsed"]);
		} finally {
			await handle.close();
		}
	});
});
