import type { FileHandle } from "node:fs/promises";
import { TextDecoder } from "node:util";

export type JsonlHeadRecord =
	| { kind: "empty"; bytesExamined: number; recordsExamined: number }
	| { kind: "parsed"; value: unknown; bytesExamined: number; recordsExamined: number }
	| {
			kind: "incomplete" | "invalid_unicode" | "malformed" | "oversized" | "source_changed";
			bytesExamined: number;
			recordsExamined: number;
	  };

const utf8Decoder = new TextDecoder("utf-8", { fatal: true });

export async function readJsonlHeadRecord(input: {
	fileHandle: FileHandle;
	fileSize: number;
	maxBytes: number;
	maxRawRecordBytes: number;
	chunkBytes: number;
	deadlineAt: number;
}): Promise<JsonlHeadRecord> {
	if (input.fileSize === 0 || input.maxBytes <= 0) {
		return { kind: "empty", bytesExamined: 0, recordsExamined: 0 };
	}
	const parts: Buffer[] = [];
	let bytesExamined = 0;
	let recordBytes = 0;
	let position = 0;
	let terminated = false;

	while (position < input.fileSize && bytesExamined < input.maxBytes && Date.now() <= input.deadlineAt) {
		const requestedBytes = Math.min(input.chunkBytes, input.fileSize - position, input.maxBytes - bytesExamined);
		const chunk = Buffer.allocUnsafe(requestedBytes);
		const { bytesRead } = await input.fileHandle.read(chunk, 0, requestedBytes, position);
		if (bytesRead !== requestedBytes) {
			return { kind: "source_changed", bytesExamined, recordsExamined: 1 };
		}
		bytesExamined += bytesRead;
		position += bytesRead;
		const newlineIndex = chunk.indexOf(10);
		const recordPart = newlineIndex >= 0 ? chunk.subarray(0, newlineIndex) : chunk;
		recordBytes += recordPart.length;
		if (recordBytes > input.maxRawRecordBytes) {
			return { kind: "oversized", bytesExamined, recordsExamined: 1 };
		}
		parts.push(recordPart);
		if (newlineIndex >= 0) {
			terminated = true;
			break;
		}
	}

	if (parts.length === 0) {
		return { kind: "empty", bytesExamined, recordsExamined: 0 };
	}
	let bytes = parts.length === 1 ? (parts[0] as Buffer) : Buffer.concat(parts);
	if (bytes.length > 0 && bytes[bytes.length - 1] === 13) {
		bytes = bytes.subarray(0, bytes.length - 1);
	}
	let text: string;
	try {
		text = utf8Decoder.decode(bytes);
	} catch {
		return { kind: "invalid_unicode", bytesExamined, recordsExamined: 1 };
	}
	try {
		return { kind: "parsed", value: JSON.parse(text) as unknown, bytesExamined, recordsExamined: 1 };
	} catch {
		return {
			kind: terminated ? "malformed" : "incomplete",
			bytesExamined,
			recordsExamined: 1,
		};
	}
}
