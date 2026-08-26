import type { FileHandle } from "node:fs/promises";
import { TextDecoder } from "node:util";

export type JsonlTailRecord =
	| {
			kind: "parsed";
			value: unknown;
			byteOffset: number;
			byteLength: number;
			terminated: boolean;
	  }
	| {
			kind: "malformed" | "incomplete" | "invalid_unicode" | "oversized";
			byteOffset: number;
			byteLength: number;
			terminated: boolean;
	  };

export interface JsonlTailScanResult {
	bytesExamined: number;
	recordsExamined: number;
	reachedStart: boolean;
	stoppedByConsumer: boolean;
	limitReached: "bytes" | "records" | null;
	sourceChanged: boolean;
	deadlineReached: boolean;
}

export interface ScanJsonlTailInput {
	fileHandle: FileHandle;
	fileSize: number;
	maxBytes: number;
	maxRecords: number;
	maxRawRecordBytes: number;
	chunkBytes: number;
	deadlineAt: number;
	onRecord(record: JsonlTailRecord): boolean;
}

const utf8Decoder = new TextDecoder("utf-8", { fatal: true });

function decodeRecord(parts: readonly Buffer[]): { value?: unknown; invalidUnicode: boolean; malformed: boolean } {
	const ordered = [...parts].reverse();
	let bytes = ordered.length === 1 ? (ordered[0] as Buffer) : Buffer.concat(ordered);
	if (bytes.length > 0 && bytes[bytes.length - 1] === 13) {
		bytes = bytes.subarray(0, bytes.length - 1);
	}
	let text: string;
	try {
		text = utf8Decoder.decode(bytes);
	} catch {
		return { invalidUnicode: true, malformed: false };
	}
	try {
		return { value: JSON.parse(text) as unknown, invalidUnicode: false, malformed: false };
	} catch {
		return { invalidUnicode: false, malformed: true };
	}
}

export async function scanJsonlTail(input: ScanJsonlTailInput): Promise<JsonlTailScanResult> {
	let position = input.fileSize;
	let bytesExamined = 0;
	let recordsExamined = 0;
	let currentParts: Buffer[] = [];
	let currentLength = 0;
	let currentOversized = false;
	let stoppedByConsumer = false;
	let limitReached: JsonlTailScanResult["limitReached"] = null;
	let sourceChanged = false;
	let deadlineReached = false;
	let firstRecord = true;
	let currentRecordTerminated = false;

	const appendPart = (part: Buffer): void => {
		if (part.length === 0) {
			return;
		}
		currentLength += part.length;
		if (currentOversized || currentLength > input.maxRawRecordBytes) {
			currentOversized = true;
			currentParts = [];
			return;
		}
		currentParts.push(part);
	};

	const emitRecord = (byteOffset: number, terminated: boolean): boolean => {
		if (firstRecord && currentLength === 0 && byteOffset === input.fileSize) {
			firstRecord = false;
			currentParts = [];
			currentLength = 0;
			currentOversized = false;
			return true;
		}
		firstRecord = false;
		recordsExamined += 1;
		let record: JsonlTailRecord;
		if (currentOversized) {
			record = {
				kind: "oversized",
				byteOffset,
				byteLength: currentLength,
				terminated,
			};
		} else {
			const decoded = decodeRecord(currentParts);
			if (decoded.invalidUnicode) {
				record = { kind: "invalid_unicode", byteOffset, byteLength: currentLength, terminated };
			} else if (decoded.malformed) {
				record = {
					kind: terminated ? "malformed" : "incomplete",
					byteOffset,
					byteLength: currentLength,
					terminated,
				};
			} else {
				record = {
					kind: "parsed",
					value: decoded.value,
					byteOffset,
					byteLength: currentLength,
					terminated,
				};
			}
		}
		currentParts = [];
		currentLength = 0;
		currentOversized = false;
		return input.onRecord(record);
	};

	while (position > 0 && !stoppedByConsumer) {
		if (Date.now() > input.deadlineAt) {
			deadlineReached = true;
			break;
		}
		if (recordsExamined >= input.maxRecords) {
			limitReached = "records";
			break;
		}
		const remainingBytes = input.maxBytes - bytesExamined;
		if (remainingBytes <= 0) {
			limitReached = "bytes";
			break;
		}
		const requestedBytes = Math.min(input.chunkBytes, position, remainingBytes);
		const chunkStart = position - requestedBytes;
		const chunk = Buffer.allocUnsafe(requestedBytes);
		const { bytesRead } = await input.fileHandle.read(chunk, 0, requestedBytes, chunkStart);
		if (bytesRead !== requestedBytes) {
			sourceChanged = true;
			break;
		}
		position = chunkStart;
		bytesExamined += bytesRead;
		if (Date.now() > input.deadlineAt) {
			deadlineReached = true;
			break;
		}
		let segmentEnd = bytesRead;
		for (let index = bytesRead - 1; index >= 0; index -= 1) {
			if (chunk[index] !== 10) {
				continue;
			}
			appendPart(chunk.subarray(index + 1, segmentEnd));
			const shouldContinue = emitRecord(chunkStart + index + 1, currentRecordTerminated);
			currentRecordTerminated = true;
			segmentEnd = index;
			if (!shouldContinue) {
				stoppedByConsumer = true;
				break;
			}
			if (recordsExamined >= input.maxRecords) {
				limitReached = "records";
				break;
			}
		}
		if (stoppedByConsumer || limitReached) {
			break;
		}
		appendPart(chunk.subarray(0, segmentEnd));
	}

	if (position === 0 && !stoppedByConsumer && !limitReached && !sourceChanged && currentLength > 0) {
		stoppedByConsumer = !emitRecord(0, currentRecordTerminated);
	}

	return {
		bytesExamined,
		recordsExamined,
		reachedStart: position === 0 && !limitReached && !sourceChanged && !deadlineReached,
		stoppedByConsumer,
		limitReached,
		sourceChanged,
		deadlineReached,
	};
}
