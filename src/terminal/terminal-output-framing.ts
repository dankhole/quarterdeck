const ESC = 0x1b;
const CAN = 0x18;
const SUB = 0x1a;

export const MAX_RETAINED_TERMINAL_FRAME_BYTES = 64 * 1024;

type ParserMode =
	| "ground"
	| "escape"
	| "escape-intermediate"
	| "csi-entry"
	| "csi-param"
	| "csi-intermediate"
	| "csi-ignore"
	| "osc"
	| "string"
	| "dcs-entry"
	| "dcs-param"
	| "dcs-intermediate"
	| "dcs-ignore"
	| "dcs-passthrough";

export interface FramedTerminalOutput {
	bytes: Buffer;
	/** False for fragments of an overflowed frame, even its closing fragment. */
	canIntercept: boolean;
}

/**
 * Holds incomplete UTF-8/VT frames up to a fixed bound. On overflow, streams
 * their original bytes exactly once and disables snapshots until parser ground
 * is recovered. At most three trailing UTF-8 bytes stay withheld while streaming,
 * so xterm's byte decoder never receives an incomplete UTF-8 unit.
 *
 * This follows the pinned xterm 6 VT500 transition table, including error-to-
 * ground transitions. It does not serialize persistent charset/grapheme state.
 */
export class TerminalOutputFraming {
	private mode: ParserMode = "ground";
	private utf8Remaining = 0;
	private utf8Length = 0;
	private utf8Codepoint = 0;
	private utf8Minimum = 0;
	private storage: Buffer | null = null;
	private storedLength = 0;
	private streaming = false;

	get pendingChunk(): Buffer | null {
		return this.storage?.subarray(0, this.storedLength) ?? null;
	}

	/** Fully withheld pending frames do not make the applied mirror unsafe. */
	get isSnapshotSafe(): boolean {
		return !this.streaming;
	}

	push(incoming: Buffer): FramedTerminalOutput[] {
		const segments: FramedTerminalOutput[] = [];
		let segmentStart = 0;
		let inFrame = this.storage !== null || this.streaming;

		for (let index = 0; index < incoming.byteLength; index += 1) {
			this.advanceByte(incoming[index] as number);
			const safe = this.mode === "ground" && this.utf8Remaining === 0;
			if (!safe && !inFrame) {
				if (index > segmentStart)
					segments.push({ bytes: incoming.subarray(segmentStart, index), canIntercept: true });
				segmentStart = index;
				inFrame = true;
			} else if (safe && inFrame) {
				this.releaseFrame(incoming.subarray(segmentStart, index + 1), segments);
				segmentStart = index + 1;
				inFrame = false;
			}
		}

		if (segmentStart < incoming.byteLength) {
			const fragment = incoming.subarray(segmentStart);
			if (!inFrame) {
				segments.push({ bytes: fragment, canIntercept: true });
			} else if (!this.streaming && this.storedLength + fragment.byteLength <= MAX_RETAINED_TERMINAL_FRAME_BYTES) {
				this.append(fragment);
			} else {
				this.streamFrame(fragment, segments);
			}
		}
		return segments;
	}

	private releaseFrame(fragment: Buffer, segments: FramedTerminalOutput[]): void {
		if (!this.storage) {
			segments.push({ bytes: fragment, canIntercept: !this.streaming });
		} else if (!this.streaming && this.storedLength + fragment.byteLength <= MAX_RETAINED_TERMINAL_FRAME_BYTES) {
			this.append(fragment);
			segments.push({ bytes: this.storage.subarray(0, this.storedLength), canIntercept: true });
		} else {
			// Do not grow retained storage for an oversized frame that completes
			// in this call. Both pieces belong to the same atomic pipeline write.
			segments.push({ bytes: this.storage.subarray(0, this.storedLength), canIntercept: false });
			segments.push({ bytes: fragment, canIntercept: false });
		}
		this.storage = null;
		this.storedLength = 0;
		this.streaming = false;
	}

	private streamFrame(fragment: Buffer, segments: FramedTerminalOutput[]): void {
		this.streaming = true;
		const outputLength = this.storedLength + fragment.byteLength - this.utf8Length;
		const storedOutputLength = Math.min(outputLength, this.storedLength);
		if (storedOutputLength > 0 && this.storage) {
			segments.push({ bytes: this.storage.subarray(0, storedOutputLength), canIntercept: false });
		}
		const fragmentOutputLength = outputLength - storedOutputLength;
		if (fragmentOutputLength > 0) {
			segments.push({ bytes: fragment.subarray(0, fragmentOutputLength), canIntercept: false });
		}

		// Retain only the unfinished UTF-8 unit, never a growing string payload.
		// Copy before retiring storage; emitted views must never be reused.
		const tail = this.utf8Length > 0 ? Buffer.allocUnsafe(this.utf8Length) : null;
		if (tail) {
			const storedTailLength = this.storedLength - storedOutputLength;
			this.storage?.copy(tail, 0, storedOutputLength, this.storedLength);
			fragment.copy(tail, storedTailLength, fragmentOutputLength);
		}
		this.storage = tail;
		this.storedLength = tail?.byteLength ?? 0;
	}

	private append(fragment: Buffer): void {
		const required = this.storedLength + fragment.byteLength;
		// Callers check the bound before this allocation, not after copying.
		if (!this.storage || this.storage.byteLength < required) {
			const capacity = Math.min(
				MAX_RETAINED_TERMINAL_FRAME_BYTES,
				Math.max(required, (this.storage?.byteLength ?? 32) * 2),
			);
			const storage = Buffer.allocUnsafe(capacity);
			this.storage?.copy(storage, 0, 0, this.storedLength);
			this.storage = storage;
		}
		fragment.copy(this.storage, this.storedLength);
		this.storedLength = required;
	}

	private advanceByte(byte: number): void {
		if (this.utf8Remaining > 0) {
			if ((byte & 0xc0) === 0x80) {
				this.utf8Codepoint = (this.utf8Codepoint << 6) | (byte & 0x3f);
				this.utf8Length += 1;
				this.utf8Remaining -= 1;
				if (this.utf8Remaining === 0) {
					this.utf8Length = 0;
					const code = this.utf8Codepoint;
					if (
						code >= this.utf8Minimum &&
						code <= 0x10ffff &&
						code !== 0xfeff &&
						!(code >= 0xd800 && code <= 0xdfff)
					) {
						this.advanceParser(code);
					}
				}
				return;
			}
			this.utf8Remaining = 0;
			this.utf8Length = 0;
		}

		if (byte < 0x80) {
			this.advanceParser(byte);
		} else if (byte >= 0xc0 && byte <= 0xf7) {
			// xterm can retain these structural starters even when the completed
			// encoding is invalid (C0/C1, F5..F7, overlongs, surrogates).
			this.utf8Remaining = byte < 0xe0 ? 1 : byte < 0xf0 ? 2 : 3;
			this.utf8Length = 1;
			this.utf8Minimum = byte < 0xe0 ? 0x80 : byte < 0xf0 ? 0x800 : 0x10000;
			this.utf8Codepoint = byte & (byte < 0xe0 ? 0x1f : byte < 0xf0 ? 0x0f : 0x07);
		}
	}

	private advanceParser(code: number): void {
		if (code === ESC) {
			this.mode = "escape";
			return;
		}
		if (code === CAN || code === SUB) {
			this.mode = "ground";
			return;
		}
		// C1 controls arrive as UTF-8, not raw 80..9F. These are xterm's
		// anywhere transitions, including the string terminator ST.
		if (code >= 0x80 && code <= 0x9f) {
			switch (code) {
				case 0x90:
					this.mode = "dcs-entry";
					break;
				case 0x9b:
					this.mode = "csi-entry";
					break;
				case 0x9d:
					this.mode = "osc";
					break;
				case 0x98:
				case 0x9e:
				case 0x9f:
					this.mode = "string";
					break;
				default:
					this.mode = "ground";
			}
			return;
		}

		// Other C0 controls remain in the current state (OSC BEL is special).
		if (code < 0x20) {
			if (this.mode === "osc" && code === 0x07) this.mode = "ground";
			return;
		}
		const intermediate = code >= 0x20 && code <= 0x2f;
		const parameter = code >= 0x30 && code <= 0x3b;
		const prefix = code >= 0x3c && code <= 0x3f;
		const final = code >= 0x40 && code <= 0x7e;
		const del = code === 0x7f;

		switch (this.mode) {
			case "ground":
				break;
			case "escape":
				if (del) break;
				if (intermediate) this.mode = "escape-intermediate";
				else if (code === 0x5b) this.mode = "csi-entry";
				else if (code === 0x5d) this.mode = "osc";
				else if (code === 0x50) this.mode = "dcs-entry";
				else if (code === 0x58 || code === 0x5e || code === 0x5f) this.mode = "string";
				else this.mode = "ground";
				break;
			case "escape-intermediate":
				if (!intermediate && !del) this.mode = "ground";
				break;
			case "csi-entry":
				if (intermediate) this.mode = "csi-intermediate";
				else if (parameter || prefix) this.mode = "csi-param";
				else if (!del) this.mode = "ground";
				break;
			case "csi-param":
				if (intermediate) this.mode = "csi-intermediate";
				else if (prefix) this.mode = "csi-ignore";
				else if (!parameter && !del) this.mode = "ground";
				break;
			case "csi-intermediate":
				if (parameter || prefix) this.mode = "csi-ignore";
				else if (!intermediate && !del) this.mode = "ground";
				break;
			case "csi-ignore":
				if (final) this.mode = "ground";
				break;
			case "osc":
				break;
			case "string":
				if (code >= 0xa0) this.mode = "ground";
				break;
			case "dcs-entry":
				if (intermediate) this.mode = "dcs-intermediate";
				else if (parameter || prefix) this.mode = "dcs-param";
				else if (final) this.mode = "dcs-passthrough";
				else if (!del) this.mode = "ground";
				break;
			case "dcs-param":
				if (intermediate) this.mode = "dcs-intermediate";
				else if (prefix) this.mode = "dcs-ignore";
				else if (final) this.mode = "dcs-passthrough";
				else if (!parameter && !del) this.mode = "ground";
				break;
			case "dcs-intermediate":
				if (parameter || prefix) this.mode = "dcs-ignore";
				else if (final) this.mode = "dcs-passthrough";
				else if (!intermediate && !del) this.mode = "ground";
				break;
			case "dcs-ignore":
			case "dcs-passthrough":
				break;
		}
	}
}
