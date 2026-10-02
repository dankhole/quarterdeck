import type { FileHandle } from "node:fs/promises";
import { TextDecoder } from "node:util";

export interface IncrementalJsonlPosition {
	offset: number;
	partial: Buffer;
	discardUntilNewline: boolean;
}

export type IncrementalJsonlRecord =
	| { kind: "parsed"; value: unknown; byteOffset: number; bytes: Buffer }
	| { kind: "opaque" };

/** Reads forward without dropping records when one work budget ends inside a line. */
export async function readIncrementalJsonl(input: {
	fileHandle: FileHandle;
	fileSize: number;
	position: IncrementalJsonlPosition;
	maxBytes: number;
	maxRecords: number;
	maxRawRecordBytes: number;
	chunkBytes: number;
	deadlineAt: number;
	onRecord: (record: IncrementalJsonlRecord) => void;
}): Promise<{ position: IncrementalJsonlPosition; bytesExamined: number; sourceChanged: boolean }> {
	const position: IncrementalJsonlPosition = {
		offset: input.position.offset,
		partial: input.position.partial,
		discardUntilNewline: input.position.discardUntilNewline,
	};
	const decoder = new TextDecoder("utf-8", { fatal: true });
	let bytesExamined = 0;
	let recordsExamined = 0;
	while (
		position.offset < input.fileSize &&
		bytesExamined < input.maxBytes &&
		recordsExamined < input.maxRecords &&
		Date.now() <= input.deadlineAt
	) {
		const requested = Math.min(input.chunkBytes, input.fileSize - position.offset, input.maxBytes - bytesExamined);
		const chunk = Buffer.allocUnsafe(requested);
		const { bytesRead } = await input.fileHandle.read(chunk, 0, requested, position.offset);
		bytesExamined += bytesRead;
		if (bytesRead !== requested) return { position, bytesExamined, sourceChanged: true };
		let start = 0;
		while (start < bytesRead && recordsExamined < input.maxRecords) {
			const newline = chunk.indexOf(10, start);
			const end = newline < 0 ? bytesRead : newline + 1;
			const part = chunk.subarray(start, newline < 0 ? end : newline);
			position.offset += end - start;
			if (!position.discardUntilNewline) {
				if (position.partial.length + part.length > input.maxRawRecordBytes) {
					position.partial = Buffer.alloc(0);
					position.discardUntilNewline = true;
					input.onRecord({ kind: "opaque" });
				} else {
					position.partial = position.partial.length ? Buffer.concat([position.partial, part]) : Buffer.from(part);
				}
			}
			if (newline >= 0) {
				recordsExamined += 1;
				if (!position.discardUntilNewline && position.partial.length) {
					try {
						input.onRecord({
							kind: "parsed",
							value: JSON.parse(decoder.decode(position.partial)) as unknown,
							byteOffset: position.offset - position.partial.length - 1,
							bytes: position.partial,
						});
					} catch {
						input.onRecord({ kind: "opaque" });
					}
				}
				position.partial = Buffer.alloc(0);
				position.discardUntilNewline = false;
			}
			start = end;
		}
	}
	return { position, bytesExamined, sourceChanged: false };
}
