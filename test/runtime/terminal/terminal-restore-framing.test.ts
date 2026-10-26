import headlessModule, { type Terminal as HeadlessTerminal } from "@xterm/headless";
import { describe, expect, it } from "vitest";
import { MAX_RETAINED_TERMINAL_FRAME_BYTES } from "../../../src/terminal/terminal-output-framing";
import {
	createTerminalProtocolFilterState,
	filterTerminalProtocolOutput,
} from "../../../src/terminal/terminal-protocol-filter";
import {
	TerminalRestoreSnapshotUnavailableError,
	type TerminalScreenSnapshot,
	TerminalStateMirror,
} from "../../../src/terminal/terminal-state-mirror";

const { Terminal } = headlessModule as { Terminal: typeof HeadlessTerminal };

function write(terminal: HeadlessTerminal, bytes: Buffer | string): Promise<void> {
	return new Promise((resolve) => terminal.write(bytes, resolve));
}

function contents(terminal: HeadlessTerminal) {
	const buffer = terminal.buffer.active;
	return {
		lines: Array.from({ length: buffer.length }, (_, row) => buffer.getLine(row)?.translateToString(true)),
		cursorX: buffer.cursorX,
		cursorY: buffer.cursorY,
		baseY: buffer.baseY,
	};
}

const cases = [
	{ name: "euro", frame: Buffer.from("€"), split: 1 },
	{ name: "euro second continuation", frame: Buffer.from("€"), split: 2 },
	{ name: "emoji", frame: Buffer.from("😀"), split: 1 },
	{ name: "emoji second continuation", frame: Buffer.from("😀"), split: 2 },
	{ name: "emoji third continuation", frame: Buffer.from("😀"), split: 3 },
	{ name: "combining mark", frame: Buffer.from("\u0301"), split: 1 },
	{ name: "ESC charset intermediate", frame: Buffer.from("\u001b(B"), split: 2 },
	{ name: "ESC alignment intermediate", frame: Buffer.from("\u001b#8"), split: 2 },
	{ name: "DCS header", frame: Buffer.from("\u001bP1;2$qpayload\u001b\\"), split: 5 },
	{ name: "DCS payload", frame: Buffer.from("\u001bP1;2$qpayload\u001b\\"), split: 10 },
	{ name: "DCS ST", frame: Buffer.from("\u001bP1;2$qpayload\u001b\\"), split: 15 },
	{ name: "APC payload", frame: Buffer.from("\u001b_payload\u001b\\"), split: 5 },
	{ name: "OSC ST", frame: Buffer.from("\u001b]2;title\u001b\\"), split: 10 },
	{ name: "CSI", frame: Buffer.from("\u001b[31m"), split: 3 },
	{ name: "UTF-8 C1 string", frame: Buffer.from("\u009fpayload\u009c"), split: 1 },
	{ name: "cancelled OSC", frame: Buffer.from("\u001b]2;title\u0018"), split: 8 },
	{ name: "ignored BOM in escape", frame: Buffer.from("\u001b(\ufeffB"), split: 5 },
	{ name: "invalid UTF-8 starter", frame: Buffer.from([0xf5, 0x80, 0x80, 0x80]), split: 2 },
];

describe("terminal restore framing", () => {
	it.each(["\u001b[c", "\u001b]10;?\u0007", "\u001b]11;?\u001b\\"])(
		"refuses an overflow snapshot and recovers after forwarding closing query %j",
		async (closingQuery) => {
			const filter = createTerminalProtocolFilterState({
				interceptOscColorQueries: true,
				suppressDeviceAttributeQueries: true,
			});
			const mirror = new TerminalStateMirror(40, 4);
			const live = new Terminal({ allowProposedApi: true, cols: 40, rows: 4, scrollback: 100 });
			const raw = new Terminal({ allowProposedApi: true, cols: 40, rows: 4, scrollback: 100 });
			const restored = new Terminal({ allowProposedApi: true, cols: 40, rows: 4, scrollback: 100 });
			try {
				const prefix = Buffer.concat([
					Buffer.from("rendered\u001bPq"),
					Buffer.alloc(MAX_RETAINED_TERMINAL_FRAME_BYTES, 0x61),
				]);
				const first = filterTerminalProtocolOutput(filter, prefix);
				mirror.applyOutput(first, undefined, { restoreSnapshotSafe: filter.framing.isSnapshotSafe });
				await write(live, first);
				await expect(mirror.getSnapshot()).rejects.toBeInstanceOf(TerminalRestoreSnapshotUnavailableError);

				const suffix = Buffer.from(`${closingQuery} after`);
				const second = filterTerminalProtocolOutput(filter, suffix);
				expect(second).toEqual(suffix);
				expect(filter.framing.isSnapshotSafe).toBe(true);
				mirror.applyOutput(second, undefined, { restoreSnapshotSafe: filter.framing.isSnapshotSafe });
				await write(live, second);
				const snapshot = await mirror.getSnapshot();
				if (!snapshot) throw new Error("Expected snapshot after framing recovery");
				await write(restored, snapshot.snapshot);
				await write(raw, Buffer.concat([prefix, suffix]));
				expect(contents(restored)).toEqual(contents(live));
				expect(contents(restored)).toEqual(contents(raw));
				expect(contents(restored).lines[0]).toBe("rendered after");
			} finally {
				mirror.dispose();
				live.dispose();
				raw.dispose();
				restored.dispose();
			}
		},
	);

	it.each([
		["APC Unicode", "\u001b_é"],
		["PM Unicode", "\u001b^é"],
		["SOS Unicode", "\u001bXé"],
		["CSI entry Unicode", "\u001b[é"],
		["CSI parameter Unicode", "\u001b[1é"],
		["CSI intermediate Unicode", "\u001b[ é"],
		["DCS entry Unicode", "\u001bPé"],
		["DCS parameter Unicode", "\u001bP1é"],
		["DCS intermediate Unicode", "\u001bP é"],
	])("matches pinned headless error recovery for %s", async (_name, prefix) => {
		const filter = createTerminalProtocolFilterState();
		const bytes = Buffer.from(`${prefix}123\n456`);
		const output = filterTerminalProtocolOutput(filter, bytes);
		expect(output).toEqual(bytes);
		expect(filter.framing.pendingChunk).toBeNull();
		expect(filter.framing.isSnapshotSafe).toBe(true);
		const raw = new Terminal({ allowProposedApi: true, cols: 40, rows: 4 });
		const framed = new Terminal({ allowProposedApi: true, cols: 40, rows: 4 });
		try {
			await write(raw, bytes);
			await write(framed, output);
			expect(contents(framed)).toEqual(contents(raw));
			expect(contents(framed).lines[0]).toBe("123");
			expect(contents(framed).lines[1]).toBe("   456");
		} finally {
			raw.dispose();
			framed.dispose();
		}
	});

	it.each([
		["CSI ignore", "\u001b[1?é123"],
		["DCS ignore", "\u001bP 1é123"],
		["DCS payload", "\u001bPqé123"],
		["DCS parameter DEL", "\u001bP1\u007f123"],
		["CSI parameter DEL", "\u001b[1\u007f123"],
		["DCS parameter prefix ignore", "\u001bP1?123"],
		["OSC payload", "\u001b]2;é123"],
	])("retains %s instead of falsely recovering on Unicode or DEL", async (_name, prefix) => {
		const filter = createTerminalProtocolFilterState();
		expect(filterTerminalProtocolOutput(filter, Buffer.from(prefix))).toHaveLength(0);
		expect(filter.framing.pendingChunk).toEqual(Buffer.from(prefix));
		expect(filter.framing.isSnapshotSafe).toBe(true);
		const suffix = "\u0018after";
		const output = filterTerminalProtocolOutput(filter, Buffer.from(suffix));
		expect(output).toEqual(Buffer.from(prefix + suffix));
		const raw = new Terminal({ allowProposedApi: true, cols: 40, rows: 4 });
		const framed = new Terminal({ allowProposedApi: true, cols: 40, rows: 4 });
		try {
			await write(raw, Buffer.from(prefix + suffix));
			await write(framed, output);
			expect(contents(framed)).toEqual(contents(raw));
			expect(contents(framed).lines[0]).toBe("after");
		} finally {
			raw.dispose();
			framed.dispose();
		}
	});

	it.each(cases)(
		"restores between chunks of $name without replaying the covered ASCII prefix",
		async ({ frame, split }) => {
			const mirror = new TerminalStateMirror(40, 4);
			const uninterrupted = new Terminal({ allowProposedApi: true, cols: 40, rows: 4, scrollback: 100 });
			const restored = new Terminal({ allowProposedApi: true, cols: 40, rows: 4, scrollback: 100 });
			try {
				const filter = createTerminalProtocolFilterState();
				const prefix = Buffer.from("already rendered e");
				const beforeRestore = Buffer.concat([prefix, frame.subarray(0, split)]);
				const afterRestore = Buffer.concat([frame.subarray(split), Buffer.from(" after")]);
				const firstOutput = filterTerminalProtocolOutput(filter, beforeRestore);
				expect(firstOutput).toEqual(prefix);
				const coveredCursor = mirror.applyOutput(firstOutput);
				const snapshot = await mirror.getSnapshot();
				expect(snapshot).not.toBeNull();
				if (!snapshot) throw new Error("Expected a live mirror snapshot");
				expect(snapshot.outputCursor).toEqual(coveredCursor);
				await write(restored, snapshot.snapshot);

				// A cursor-aware restore drops firstOutput: it is represented by the
				// snapshot. Only newly completed raw framing bytes follow the restore.
				const suffix = filterTerminalProtocolOutput(filter, afterRestore);
				expect(suffix).toEqual(Buffer.concat([frame, Buffer.from(" after")]));
				const mirrorScreen = new Promise<TerminalScreenSnapshot>((resolve) => mirror.applyOutput(suffix, resolve));
				await write(restored, suffix);
				// One complete raw write avoids relying on xterm's chunk-dependent
				// behavior for malformed UTF-8 while checking byte-preserving output.
				await write(uninterrupted, Buffer.concat([beforeRestore, afterRestore]));
				expect(contents(restored)).toEqual(contents(uninterrupted));
				const screen = await mirrorScreen;
				expect(contents(restored).lines).toEqual(screen.lines);
				expect(contents(restored).cursorY).toEqual(screen.cursorRow);
				expect(filter.framing.pendingChunk).toBeNull();
			} finally {
				mirror.dispose();
				uninterrupted.dispose();
				restored.dispose();
			}
		},
	);
});
