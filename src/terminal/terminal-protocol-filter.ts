import { TerminalOutputFraming } from "./terminal-output-framing";

const ESC = 0x1b;
const BEL = 0x07;
const OSC_INTRODUCER = 0x5d;
const CSI_INTRODUCER = 0x5b;
const STRING_TERMINATOR = 0x5c;
const DEVICE_ATTRIBUTES_FINAL = 0x63;

export interface TerminalProtocolFilterState {
	readonly framing: TerminalOutputFraming;
	interceptOscColorQueries: boolean;
	suppressDeviceAttributeQueries: boolean;
}

export interface CreateTerminalProtocolFilterStateOptions {
	interceptOscColorQueries?: boolean;
	suppressDeviceAttributeQueries?: boolean;
}

export interface FilterTerminalProtocolOutputOptions {
	onOsc10ForegroundQuery?: () => void;
	onOsc11BackgroundQuery?: () => void;
}

export function createTerminalProtocolFilterState(
	options: CreateTerminalProtocolFilterStateOptions = {},
): TerminalProtocolFilterState {
	return {
		framing: new TerminalOutputFraming(),
		interceptOscColorQueries: options.interceptOscColorQueries ?? false,
		suppressDeviceAttributeQueries: options.suppressDeviceAttributeQueries ?? false,
	};
}

export function disableOscColorQueryIntercept(state: TerminalProtocolFilterState): void {
	state.interceptOscColorQueries = false;
}

function suppressProtocolFrame(
	state: TerminalProtocolFilterState,
	frame: Buffer,
	options: FilterTerminalProtocolOutputOptions,
): boolean {
	if (frame[0] !== ESC) return false;
	if (frame[1] === CSI_INTRODUCER && state.suppressDeviceAttributeQueries && frame.byteLength <= 5) {
		if (frame[frame.byteLength - 1] !== DEVICE_ATTRIBUTES_FINAL) return false;
		const body = frame.subarray(2, -1).toString("utf8");
		return body === "" || body === "0" || body === ">" || body === ">0";
	}
	if (frame[1] === OSC_INTRODUCER && state.interceptOscColorQueries && frame.byteLength <= 8) {
		const contentEnd =
			frame[frame.byteLength - 1] === BEL
				? frame.byteLength - 1
				: frame[frame.byteLength - 2] === ESC && frame[frame.byteLength - 1] === STRING_TERMINATOR
					? frame.byteLength - 2
					: -1;
		const content = contentEnd >= 2 ? frame.subarray(2, contentEnd).toString("utf8") : "";
		if (content === "10;?") {
			options.onOsc10ForegroundQuery?.();
			return true;
		}
		if (content === "11;?") {
			options.onOsc11BackgroundQuery?.();
			return true;
		}
	}
	return false;
}

/**
 * Feed the same result and framing.isSnapshotSafe to the mirror, and the bytes
 * to listeners. Bounded frames stay withheld; oversized frames stream while
 * snapshots are unsafe. Apart from established exact OSC/DA queries, bytes are
 * delayed, never re-encoded or discarded.
 */
export function filterTerminalProtocolOutput(
	state: TerminalProtocolFilterState,
	incoming: Buffer,
	options: FilterTerminalProtocolOutputOptions = {},
): Buffer {
	const frames = state.framing.push(incoming);
	const segments = frames
		.filter((frame) => !frame.canIntercept || !suppressProtocolFrame(state, frame.bytes, options))
		.map((frame) => frame.bytes);
	if (segments.length === 0) return Buffer.alloc(0);
	if (segments.length === 1) return segments[0] as Buffer;
	return Buffer.concat(segments);
}
