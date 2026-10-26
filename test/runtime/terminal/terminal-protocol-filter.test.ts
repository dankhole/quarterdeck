import { describe, expect, it, vi } from "vitest";

import {
	createTerminalProtocolFilterState,
	disableOscColorQueryIntercept,
	filterTerminalProtocolOutput,
} from "../../../src/terminal";
import {
	MAX_RETAINED_TERMINAL_FRAME_BYTES,
	TerminalOutputFraming,
} from "../../../src/terminal/terminal-output-framing";

describe("terminal protocol filter", () => {
	it("suppresses primary and secondary device attribute queries when enabled", () => {
		const state = createTerminalProtocolFilterState({
			suppressDeviceAttributeQueries: true,
		});

		const filtered = filterTerminalProtocolOutput(
			state,
			Buffer.from("before\u001b[c middle \u001b[>0c after", "utf8"),
		);

		expect(filtered.toString("utf8")).toBe("before middle  after");
	});

	it("preserves device attribute queries when suppression is disabled", () => {
		const state = createTerminalProtocolFilterState();

		const filtered = filterTerminalProtocolOutput(state, Buffer.from("\u001b[c", "utf8"));

		expect(filtered.toString("utf8")).toBe("\u001b[c");
	});

	it("handles split device attribute queries across chunks", () => {
		const state = createTerminalProtocolFilterState({
			suppressDeviceAttributeQueries: true,
		});

		const firstChunk = filterTerminalProtocolOutput(state, Buffer.from("before\u001b[", "utf8"));
		const secondChunk = filterTerminalProtocolOutput(state, Buffer.from("cafter", "utf8"));

		expect(firstChunk.toString("utf8")).toBe("before");
		expect(secondChunk.toString("utf8")).toBe("after");
		expect(state.framing.pendingChunk).toBeNull();
	});

	it("handles OSC 11 queries split between ESC and the OSC introducer", () => {
		const onOsc11BackgroundQuery = vi.fn();
		const state = createTerminalProtocolFilterState({
			interceptOscColorQueries: true,
		});

		const firstChunk = filterTerminalProtocolOutput(state, Buffer.from("before\u001b", "utf8"), {
			onOsc11BackgroundQuery,
		});
		const secondChunk = filterTerminalProtocolOutput(state, Buffer.from("]11;?\u0007after", "utf8"), {
			onOsc11BackgroundQuery,
		});

		expect(firstChunk.toString("utf8")).toBe("before");
		expect(secondChunk.toString("utf8")).toBe("after");
		expect(onOsc11BackgroundQuery).toHaveBeenCalledTimes(1);
		expect(state.framing.pendingChunk).toBeNull();
	});

	it("intercepts OSC 10 foreground color queries", () => {
		const onOsc10ForegroundQuery = vi.fn();
		const state = createTerminalProtocolFilterState({
			interceptOscColorQueries: true,
		});

		const filtered = filterTerminalProtocolOutput(state, Buffer.from("before\u001b]10;?\u0007after", "utf8"), {
			onOsc10ForegroundQuery,
		});

		expect(filtered.toString("utf8")).toBe("beforeafter");
		expect(onOsc10ForegroundQuery).toHaveBeenCalledTimes(1);
	});

	it("handles device attribute queries split between ESC and the CSI introducer", () => {
		const state = createTerminalProtocolFilterState({
			suppressDeviceAttributeQueries: true,
		});

		const firstChunk = filterTerminalProtocolOutput(state, Buffer.from("before\u001b", "utf8"));
		const secondChunk = filterTerminalProtocolOutput(state, Buffer.from("[cafter", "utf8"));

		expect(firstChunk.toString("utf8")).toBe("before");
		expect(secondChunk.toString("utf8")).toBe("after");
		expect(state.framing.pendingChunk).toBeNull();
	});

	it("disables color query interception without affecting device attribute suppression", () => {
		const onOsc10ForegroundQuery = vi.fn();
		const onOsc11BackgroundQuery = vi.fn();
		const state = createTerminalProtocolFilterState({
			interceptOscColorQueries: true,
			suppressDeviceAttributeQueries: true,
		});

		disableOscColorQueryIntercept(state);

		const filtered = filterTerminalProtocolOutput(
			state,
			Buffer.from("\u001b]10;?\u0007\u001b]11;?\u0007\u001b[c", "utf8"),
			{ onOsc10ForegroundQuery, onOsc11BackgroundQuery },
		);

		expect(filtered.toString("utf8")).toBe("\u001b]10;?\u0007\u001b]11;?\u0007");
		expect(onOsc10ForegroundQuery).not.toHaveBeenCalled();
		expect(onOsc11BackgroundQuery).not.toHaveBeenCalled();
		expect(state.suppressDeviceAttributeQueries).toBe(true);
	});

	it("preserves pending CSI state when disabling color query interception", () => {
		const state = createTerminalProtocolFilterState({
			interceptOscColorQueries: true,
			suppressDeviceAttributeQueries: true,
		});

		const firstChunk = filterTerminalProtocolOutput(state, Buffer.from("before\u001b[", "utf8"));

		disableOscColorQueryIntercept(state);

		const secondChunk = filterTerminalProtocolOutput(state, Buffer.from("cafter", "utf8"));

		expect(firstChunk.toString("utf8")).toBe("before");
		expect(secondChunk.toString("utf8")).toBe("after");
		expect(state.framing.pendingChunk).toBeNull();
	});

	it.each(["€", "😀", "\u0301"])("retains every incomplete byte prefix of %s after rendered ASCII", (character) => {
		const bytes = Buffer.from(character);
		for (let split = 1; split < bytes.byteLength; split += 1) {
			const state = createTerminalProtocolFilterState();
			const first = filterTerminalProtocolOutput(
				state,
				Buffer.concat([Buffer.from("rendered e"), bytes.subarray(0, split)]),
			);
			expect(first).toEqual(Buffer.from("rendered e"));
			expect(state.framing.pendingChunk).toEqual(bytes.subarray(0, split));
			const second = filterTerminalProtocolOutput(
				state,
				Buffer.concat([bytes.subarray(split), Buffer.from("after")]),
			);
			expect(second).toEqual(Buffer.concat([bytes, Buffer.from("after")]));
			expect(state.framing.pendingChunk).toBeNull();
		}
	});

	it.each([
		["\u001b(", "Bafter"],
		["\u001b#", "8after"],
		["\u001bP1;2$qpayload", "\u001b\\after"],
		["\u001b_payload", "\u001b\\after"],
		["\u001b^payload", "\u001b\\after"],
		["\u001bXpayload", "\u001b\\after"],
		["\u009b31;", "1mafter"],
		["\u009dpayload", "\u009cafter"],
		["\u0090$qpayload", "\u009cafter"],
		["\u009fpayload", "\u009cafter"],
	])("frames split VT sequences without changing their bytes: %j", (prefix, suffix) => {
		const state = createTerminalProtocolFilterState();
		expect(filterTerminalProtocolOutput(state, Buffer.from(`before${prefix}`))).toEqual(Buffer.from("before"));
		expect(filterTerminalProtocolOutput(state, Buffer.from(suffix))).toEqual(Buffer.from(prefix + suffix));
		expect(state.framing.pendingChunk).toBeNull();
	});

	it.each(["\u001b[31;", "\u001b]10;?", "\u001bP$qdata", "\u001b_data", "\u001b("])(
		"releases cancelled frames, but does not intercept cancelled queries: %j",
		(prefix) => {
			for (const cancel of ["\u0018", "\u001a", "\u0085"]) {
				const onOsc10ForegroundQuery = vi.fn();
				const state = createTerminalProtocolFilterState({
					interceptOscColorQueries: true,
					suppressDeviceAttributeQueries: true,
				});
				expect(filterTerminalProtocolOutput(state, Buffer.from(prefix))).toHaveLength(0);
				expect(
					filterTerminalProtocolOutput(state, Buffer.from(`${cancel}after`), { onOsc10ForegroundQuery }),
				).toEqual(Buffer.from(`${prefix}${cancel}after`));
				expect(onOsc10ForegroundQuery).not.toHaveBeenCalled();
				expect(state.framing.pendingChunk).toBeNull();
			}
		},
	);

	it.each(["\u001b[31\r", "\u001b(\n", "\u001bP$qdata\u0007", "\u001b_data\u0007"])(
		"does not mistake ordinary C0 controls for completion: %j",
		(prefix) => {
			const state = createTerminalProtocolFilterState();
			expect(filterTerminalProtocolOutput(state, Buffer.from(prefix))).toHaveLength(0);
			expect(state.framing.pendingChunk).toEqual(Buffer.from(prefix));
			expect(filterTerminalProtocolOutput(state, Buffer.from("\u0018after"))).toEqual(
				Buffer.from(`${prefix}\u0018after`),
			);
		},
	);

	it("keeps a replacement escape attached to the abandoned frame and does not strip its cancellation", () => {
		const state = createTerminalProtocolFilterState({ interceptOscColorQueries: true });
		const onOsc10ForegroundQuery = vi.fn();
		const prefix = "\u001b[123\u001b]10;?";
		expect(filterTerminalProtocolOutput(state, Buffer.from(prefix))).toHaveLength(0);
		expect(filterTerminalProtocolOutput(state, Buffer.from("\u0007after"), { onOsc10ForegroundQuery })).toEqual(
			Buffer.from(`${prefix}\u0007after`),
		);
		expect(onOsc10ForegroundQuery).not.toHaveBeenCalled();
	});

	it.each([0xc0, 0xc1, 0xe0, 0xed, 0xf0, 0xf4, 0xf5, 0xf7])(
		"retains even a potentially invalid structural UTF-8 starter %i",
		(starter) => {
			const state = createTerminalProtocolFilterState();
			expect(filterTerminalProtocolOutput(state, Buffer.from([0x41, starter]))).toEqual(Buffer.from("A"));
			expect(state.framing.pendingChunk).toEqual(Buffer.from([starter]));
			expect(filterTerminalProtocolOutput(state, Buffer.from("B"))).toEqual(Buffer.from([starter, 0x42]));
			expect(state.framing.pendingChunk).toBeNull();
		},
	);

	it("preserves invalid UTF-8 byte fidelity, including malformed sequences immediately before escapes", () => {
		const bytes = Buffer.from([
			0x80, 0xff, 0xe0, 0x80, 0x80, 0xed, 0xa0, 0x80, 0xf5, 0x80, 0x80, 0x80, 0xc2, 0x1b, 0x23, 0x38, 0x41,
		]);
		for (let split = 0; split <= bytes.byteLength; split += 1) {
			const state = createTerminalProtocolFilterState();
			const output = Buffer.concat([
				filterTerminalProtocolOutput(state, bytes.subarray(0, split)),
				filterTerminalProtocolOutput(state, bytes.subarray(split)),
			]);
			expect(output).toEqual(bytes);
			expect(state.framing.pendingChunk).toBeNull();
		}
	});

	it("does not treat an ignored UTF-8 BOM as the final of an escape sequence", () => {
		const state = createTerminalProtocolFilterState();
		const prefix = "\u001b(\ufeff";
		expect(filterTerminalProtocolOutput(state, Buffer.from(`before${prefix}`))).toEqual(Buffer.from("before"));
		expect(filterTerminalProtocolOutput(state, Buffer.from("Bafter"))).toEqual(Buffer.from(`${prefix}Bafter`));
	});

	it("preserves mixed Unicode and control framing when every byte arrives separately", () => {
		const bytes = Buffer.from(
			"before €😀\u001b(B\u001b[31m\u001b]8;;https://example.test/€\u001b\\label\u001b]8;;\u0007\u001bP$q😀\u001b\\\u001b_😀\u001b\\after",
		);
		const state = createTerminalProtocolFilterState();
		const output = Array.from(bytes, (byte) => filterTerminalProtocolOutput(state, Buffer.from([byte])));
		expect(Buffer.concat(output)).toEqual(bytes);
		expect(state.framing.pendingChunk).toBeNull();
	});

	it("intercepts exact color and device queries even when every byte arrives separately", () => {
		const state = createTerminalProtocolFilterState({
			interceptOscColorQueries: true,
			suppressDeviceAttributeQueries: true,
		});
		const onOsc10ForegroundQuery = vi.fn();
		const onOsc11BackgroundQuery = vi.fn();
		const bytes = Buffer.from("before\u001b]10;?\u001b\\\u001b]11;?\u0007\u001b[0c\u001b[>cafter");
		const output = Array.from(bytes, (byte) =>
			filterTerminalProtocolOutput(state, Buffer.from([byte]), { onOsc10ForegroundQuery, onOsc11BackgroundQuery }),
		);
		expect(Buffer.concat(output)).toEqual(Buffer.from("beforeafter"));
		expect(onOsc10ForegroundQuery).toHaveBeenCalledTimes(1);
		expect(onOsc11BackgroundQuery).toHaveBeenCalledTimes(1);
		expect(state.framing.pendingChunk).toBeNull();
	});

	it("bounds retention and allocation before streaming an oversized frame exactly once", () => {
		const framing = new TerminalOutputFraming();
		const prefix = Buffer.from("\u001b_");
		const fragment = Buffer.alloc(1024, 0x61);
		const overflow = Buffer.alloc(MAX_RETAINED_TERMINAL_FRAME_BYTES, 0x62);
		const first = Buffer.alloc(MAX_RETAINED_TERMINAL_FRAME_BYTES - prefix.byteLength, 0x61);
		const emitted: Buffer[] = [];
		const allocate = vi.spyOn(Buffer, "allocUnsafe");
		const concat = vi.spyOn(Buffer, "concat");
		try {
			expect(framing.push(prefix)).toHaveLength(0);
			for (let offset = 0; offset < first.byteLength; offset += fragment.byteLength) {
				expect(framing.push(first.subarray(offset, offset + fragment.byteLength))).toHaveLength(0);
			}
			expect(framing.pendingChunk?.byteLength).toBe(MAX_RETAINED_TERMINAL_FRAME_BYTES);
			expect(framing.isSnapshotSafe).toBe(true);
			emitted.push(...framing.push(overflow).map((part) => part.bytes));
			expect(framing.pendingChunk).toBeNull();
			expect(framing.isSnapshotSafe).toBe(false);
			for (let index = 0; index < 16; index += 1) {
				emitted.push(...framing.push(fragment).map((part) => part.bytes));
				expect(framing.pendingChunk).toBeNull();
				expect(framing.isSnapshotSafe).toBe(false);
			}
			expect(allocate.mock.calls.every(([size]) => size <= MAX_RETAINED_TERMINAL_FRAME_BYTES)).toBe(true);
			expect(concat).not.toHaveBeenCalled();
		} finally {
			allocate.mockRestore();
			concat.mockRestore();
		}
		const suffix = Buffer.from("\u001b\\after");
		emitted.push(...framing.push(suffix).map((part) => part.bytes));
		expect(Buffer.concat(emitted)).toEqual(
			Buffer.concat([prefix, first, overflow, Buffer.alloc(16 * fragment.byteLength, 0x61), suffix]),
		);
		expect(framing.pendingChunk).toBeNull();
		expect(framing.isSnapshotSafe).toBe(true);
	});

	it("allows a snapshot when an oversized frame completes in the same call", () => {
		const state = createTerminalProtocolFilterState();
		const bytes = Buffer.concat([
			Buffer.from("\u001bPq"),
			Buffer.alloc(MAX_RETAINED_TERMINAL_FRAME_BYTES * 2, 0x61),
			Buffer.from("\u001b\\after"),
		]);
		expect(filterTerminalProtocolOutput(state, bytes)).toEqual(bytes);
		expect(state.framing.pendingChunk).toBeNull();
		expect(state.framing.isSnapshotSafe).toBe(true);
	});

	it.each(["\u001bPq", "\u001b_", "\u001b]2;"])(
		"never intercepts a query that closes streamed %j framing",
		(prefix) => {
			for (const closingQuery of ["\u001b[c", "\u001b]10;?\u0007", "\u001b]11;?\u001b\\"]) {
				const state = createTerminalProtocolFilterState({
					interceptOscColorQueries: true,
					suppressDeviceAttributeQueries: true,
				});
				const callbacks = { onOsc10ForegroundQuery: vi.fn(), onOsc11BackgroundQuery: vi.fn() };
				const oversized = Buffer.concat([
					Buffer.from(prefix),
					Buffer.alloc(MAX_RETAINED_TERMINAL_FRAME_BYTES, 0x61),
				]);
				expect(filterTerminalProtocolOutput(state, oversized, callbacks)).toEqual(oversized);
				expect(state.framing.isSnapshotSafe).toBe(false);
				expect(filterTerminalProtocolOutput(state, Buffer.from(closingQuery), callbacks)).toEqual(
					Buffer.from(closingQuery),
				);
				expect(state.framing.isSnapshotSafe).toBe(true);
				expect(callbacks.onOsc10ForegroundQuery).not.toHaveBeenCalled();
				expect(callbacks.onOsc11BackgroundQuery).not.toHaveBeenCalled();
				expect(
					filterTerminalProtocolOutput(
						state,
						Buffer.from("\u001b[c\u001b]10;?\u0007\u001b]11;?\u001b\\"),
						callbacks,
					),
				).toHaveLength(0);
				expect(callbacks.onOsc10ForegroundQuery).toHaveBeenCalledTimes(1);
				expect(callbacks.onOsc11BackgroundQuery).toHaveBeenCalledTimes(1);
			}
		},
	);

	it("keeps a UTF-8 prefix intact when that prefix crosses the retention cap", () => {
		const state = createTerminalProtocolFilterState();
		const initial = Buffer.concat([
			Buffer.from("\u001bPq"),
			Buffer.alloc(MAX_RETAINED_TERMINAL_FRAME_BYTES - 4, 0x61),
		]);
		const bytes = Buffer.from("😀");
		expect(filterTerminalProtocolOutput(state, initial)).toHaveLength(0);
		expect(filterTerminalProtocolOutput(state, bytes.subarray(0, 1))).toHaveLength(0);
		expect(state.framing.pendingChunk?.byteLength).toBe(MAX_RETAINED_TERMINAL_FRAME_BYTES);
		expect(state.framing.isSnapshotSafe).toBe(true);
		expect(filterTerminalProtocolOutput(state, bytes.subarray(1, 2))).toEqual(initial);
		expect(state.framing.pendingChunk).toEqual(bytes.subarray(0, 2));
		expect(state.framing.isSnapshotSafe).toBe(false);
		expect(filterTerminalProtocolOutput(state, bytes.subarray(2))).toEqual(bytes);
		expect(filterTerminalProtocolOutput(state, Buffer.from("\u0018"))).toEqual(Buffer.from("\u0018"));
		expect(state.framing.isSnapshotSafe).toBe(true);
	});

	it.each(["€", "😀"])("withholds only a partial %s UTF-8 unit during overflow streaming", (character) => {
		const state = createTerminalProtocolFilterState();
		const oversized = Buffer.concat([Buffer.from("\u001bPq"), Buffer.alloc(MAX_RETAINED_TERMINAL_FRAME_BYTES, 0x61)]);
		expect(filterTerminalProtocolOutput(state, oversized)).toEqual(oversized);
		const bytes = Buffer.from(character);
		for (let index = 0; index < bytes.byteLength - 1; index += 1) {
			expect(filterTerminalProtocolOutput(state, bytes.subarray(index, index + 1))).toHaveLength(0);
			expect(state.framing.pendingChunk?.byteLength).toBe(index + 1);
			expect(state.framing.isSnapshotSafe).toBe(false);
		}
		expect(filterTerminalProtocolOutput(state, bytes.subarray(-1))).toEqual(bytes);
		expect(state.framing.pendingChunk).toBeNull();
		expect(state.framing.isSnapshotSafe).toBe(false);
		expect(filterTerminalProtocolOutput(state, Buffer.from("\u0018after"))).toEqual(Buffer.from("\u0018after"));
		expect(state.framing.isSnapshotSafe).toBe(true);
	});
});
