import type { FileHandle } from "node:fs/promises";
import { TextDecoder } from "node:util";

export interface IncrementalJsonlPosition {
	offset: number;
	partial: Buffer;
	discardUntilNewline: boolean;
}

export type IncrementalJsonlRecord =
	| { kind: "parsed"; value: unknown; byteOffset: number; bytes: Buffer }
	/** Invalid JSON or a record over `maxRawRecordBytes`; `byteOffset` is the record's first byte. */
	| { kind: "opaque"; byteOffset: number };

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
	/** Optional cheap byte prefilter; complete records it rejects are skipped without parsing. */
	shouldParse?: (bytes: Buffer) => boolean;
	onRecord: (record: IncrementalJsonlRecord) => void;
}): Promise<{ position: IncrementalJsonlPosition; bytesExamined: number; sourceChanged: boolean }> {
	let offset = input.position.offset;
	let discardUntilNewline = input.position.discardUntilNewline;
	// Collect a record's pieces and concatenate once, so a large record spanning
	// many chunks is copied linearly rather than once per chunk.
	let parts: Buffer[] = input.position.partial.length ? [input.position.partial] : [];
	let partialLength = input.position.partial.length;
	let recordStart = offset - partialLength;
	const joinParts = (): Buffer => Buffer.concat(parts, partialLength);
	const currentPosition = (): IncrementalJsonlPosition => ({ offset, partial: joinParts(), discardUntilNewline });
	const decoder = new TextDecoder("utf-8", { fatal: true });
	let bytesExamined = 0;
	let recordsExamined = 0;
	while (
		offset < input.fileSize &&
		bytesExamined < input.maxBytes &&
		recordsExamined < input.maxRecords &&
		Date.now() <= input.deadlineAt
	) {
		const requested = Math.min(input.chunkBytes, input.fileSize - offset, input.maxBytes - bytesExamined);
		const chunk = Buffer.allocUnsafe(requested);
		const { bytesRead } = await input.fileHandle.read(chunk, 0, requested, offset);
		bytesExamined += bytesRead;
		if (bytesRead !== requested) return { position: currentPosition(), bytesExamined, sourceChanged: true };
		let start = 0;
		while (start < bytesRead && recordsExamined < input.maxRecords) {
			const newline = chunk.indexOf(10, start);
			const end = newline < 0 ? bytesRead : newline + 1;
			const part = chunk.subarray(start, newline < 0 ? end : newline);
			offset += end - start;
			if (!discardUntilNewline) {
				if (partialLength + part.length > input.maxRawRecordBytes) {
					parts = [];
					partialLength = 0;
					discardUntilNewline = true;
					input.onRecord({ kind: "opaque", byteOffset: recordStart });
				} else if (part.length) {
					parts.push(part);
					partialLength += part.length;
				}
			}
			if (newline >= 0) {
				recordsExamined += 1;
				if (!discardUntilNewline && partialLength) {
					// Concatenation copies, so consumers never retain the shared read chunk.
					const bytes = joinParts();
					if (input.shouldParse?.(bytes) ?? true) {
						try {
							input.onRecord({
								kind: "parsed",
								value: JSON.parse(decoder.decode(bytes)) as unknown,
								byteOffset: recordStart,
								bytes,
							});
						} catch {
							input.onRecord({ kind: "opaque", byteOffset: recordStart });
						}
					}
				}
				parts = [];
				partialLength = 0;
				discardUntilNewline = false;
				recordStart = offset;
			}
			start = end;
		}
	}
	return { position: currentPosition(), bytesExamined, sourceChanged: false };
}
