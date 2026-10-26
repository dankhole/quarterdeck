import { open, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
	type IncrementalJsonlPosition,
	type IncrementalJsonlRecord,
	readIncrementalJsonl,
} from "../../../src/conversation/incremental-jsonl-reader";
import { createTempDir } from "../../utilities/temp-dir";

const MIB = 1024 * 1024;

describe("bounded incremental JSONL recovery", () => {
	it.each([
		["oversized tool result", Buffer.from(JSON.stringify({ role: "toolResult", content: "x".repeat(2 * MIB) }))],
		["malformed JSON", Buffer.from("not-json")],
		["invalid UTF-8", Buffer.from([0xff])],
	] as const)("discards %s locally and parses the following record", async (_name, first) => {
		const temporary = createTempDir("incremental-jsonl-");
		const sourcePath = join(temporary.path, "history.jsonl");
		const following = { role: "assistant", text: "Fresh reply" };
		const followingBytes = Buffer.from(JSON.stringify(following));
		const saved = Buffer.concat([first, Buffer.from("\n"), followingBytes, Buffer.from("\n")]);
		await writeFile(sourcePath, saved);
		const fileHandle = await open(sourcePath, "r");
		try {
			let position: IncrementalJsonlPosition = { offset: 0, partial: Buffer.alloc(0), discardUntilNewline: false };
			const records: IncrementalJsonlRecord[] = [];
			for (let pass = 0; position.offset < saved.length && pass < 100; pass++) {
				const result = await readIncrementalJsonl({
					fileHandle,
					fileSize: saved.length,
					position,
					maxBytes: 128 * 1024,
					maxRecords: 256,
					maxRawRecordBytes: MIB,
					chunkBytes: 32 * 1024,
					deadlineAt: Date.now() + 1000,
					onRecord: (record) => records.push(record),
				});
				expect(result.sourceChanged).toBe(false);
				expect(result.bytesExamined).toBeLessThanOrEqual(128 * 1024);
				expect(result.position.partial.length).toBeLessThanOrEqual(MIB);
				position = result.position;
			}
			expect(position).toEqual({ offset: saved.length, partial: Buffer.alloc(0), discardUntilNewline: false });
			expect(records).toEqual([
				{ kind: "opaque", byteOffset: 0 },
				{ kind: "parsed", value: following, byteOffset: first.length + 1, bytes: followingBytes },
			]);
		} finally {
			await fileHandle.close();
			await temporary.cleanupAsync();
		}
	});
});
