import headlessModule, { type Terminal as HeadlessTerminal } from "@xterm/headless";
import { afterEach, describe, expect, it, vi } from "vitest";

import { TerminalStateMirror } from "../../../src/terminal";
import { TerminalRestoreSnapshotUnavailableError } from "../../../src/terminal/terminal-state-mirror";

const { Terminal } = headlessModule as { Terminal: typeof HeadlessTerminal };
const mirrors: TerminalStateMirror[] = [];
const viewers: HeadlessTerminal[] = [];

async function restoreViewer(mirror: TerminalStateMirror): Promise<HeadlessTerminal> {
	const snapshot = await mirror.getSnapshot();
	if (!snapshot) throw new Error("Expected a live snapshot");
	const viewer = new Terminal({ allowProposedApi: true, cols: snapshot.cols, rows: snapshot.rows, scrollback: 100 });
	viewers.push(viewer);
	await new Promise<void>((resolve) => viewer.write(snapshot.snapshot, resolve));
	return viewer;
}

function uriAt(viewer: HeadlessTerminal, row: number, col: number): string | undefined {
	const cell = viewer.buffer.active.getLine(row)?.getCell(col) as { extended: { urlId: number } } | undefined;
	const internal = viewer as unknown as {
		_core: { _oscLinkService: { getLinkData(id: number): { uri: string } | undefined } };
	};
	return cell ? internal._core._oscLinkService.getLinkData(cell.extended.urlId)?.uri : undefined;
}

function createMirror(cols = 80, rows = 24): TerminalStateMirror {
	const mirror = new TerminalStateMirror(cols, rows);
	mirrors.push(mirror);
	return mirror;
}

afterEach(() => {
	for (const viewer of viewers.splice(0)) viewer.dispose();
	while (mirrors.length > 0) {
		mirrors.pop()?.dispose();
	}
});

describe("TerminalStateMirror", () => {
	it("keeps an untouched snapshot empty for the stale-empty browser restore guard", async () => {
		const mirror = createMirror();
		const snapshot = await mirror.getSnapshot();
		// shouldSkipEmptyRestoreSnapshot uses length === 0 to protect live output
		// received before this snapshot. Protocol-only bytes break that sentinel.
		expect(snapshot).toEqual({
			snapshot: "",
			cols: 80,
			rows: 24,
			outputCursor: { streamId: expect.any(String), sequence: 0 },
		});
	});

	it.each([false, true])("restores actual OSC 8 URI metadata from split writes (batching=%s)", async (batching) => {
		const mirror = createMirror(20, 4);
		mirror.setBatching(batching);
		for (const chunk of [
			"\u001b]8;id=one;https://",
			"example.test/first\u001b",
			"\\label\u001b]8;;",
			"\u0007 plain",
		]) {
			mirror.applyOutput(Buffer.from(chunk));
		}
		const viewer = await restoreViewer(mirror);
		expect(viewer.buffer.active.getLine(0)?.translateToString(true)).toBe("label plain");
		for (let col = 0; col < 5; col += 1) expect(uriAt(viewer, 0, col)).toBe("https://example.test/first");
		expect(uriAt(viewer, 0, 5)).toBeUndefined();
		expect(uriAt(viewer, 0, 10)).toBeUndefined();
	});

	it("retains OSC 8 targets in only the requested scrollback", async () => {
		const mirror = new TerminalStateMirror(20, 4, { scrollback: 2 });
		mirrors.push(mirror);
		for (let row = 0; row < 10; row += 1) {
			mirror.applyOutput(
				Buffer.from(`\u001b]8;;https://example.test/${row}\u001b\\row-${row}\u001b]8;;\u001b\\\r\n`),
			);
		}
		const viewer = await restoreViewer(mirror);
		expect(viewer.buffer.normal.length).toBe(6);
		expect(viewer.buffer.normal.getLine(0)?.translateToString(true)).toBe("row-5");
		expect(uriAt(viewer, 0, 0)).toBe("https://example.test/5");
		expect(uriAt(viewer, 4, 0)).toBe("https://example.test/9");
		expect(uriAt(viewer, 5, 0)).toBeUndefined();
	});

	it("reports the settled rendered viewport after an output write", async () => {
		const mirror = createMirror(40, 10);

		const rendered = await new Promise<string[]>((resolve) => {
			mirror.applyOutput(Buffer.from("\u001b[2J\u001b[Htitle\u001b[10;1Hfooter", "utf8"), (screen) =>
				resolve(screen.lines),
			);
		});

		expect(rendered[0]).toBe("title");
		expect(rendered[9]).toBe("footer");
	});

	it("reports rendered output after a detached batch flush", async () => {
		const mirror = createMirror(40, 10);
		mirror.setBatching(true);

		const renderedPromise = new Promise<string[]>((resolve) => {
			mirror.applyOutput(Buffer.from("batched", "utf8"), (screen) => resolve(screen.lines));
		});
		mirror.setBatching(false);

		expect((await renderedPromise)[0]).toBe("batched");
	});

	it("coalesces output queued behind an in-flight write into one write", async () => {
		const mirror = createMirror(40, 10);
		const order: string[] = [];
		const screens: string[] = [];
		const done = new Promise<void>((resolve) => {
			mirror.applyOutput(Buffer.from("a", "utf8"), (screen) => {
				order.push("a");
				screens.push(screen.lines[0] ?? "");
			});
			// Later macrotasks, as PTY data events arrive, while "a" is still parsing.
			setImmediate(() => {
				for (const letter of ["b", "c", "d"]) {
					mirror.applyOutput(Buffer.from(letter, "utf8"), (screen) => {
						order.push(letter);
						screens.push(screen.lines[0] ?? "");
						if (letter === "d") resolve();
					});
				}
			});
		});
		await done;

		expect(order).toEqual(["a", "b", "c", "d"]);
		expect(screens).toEqual(["a", "abcd", "abcd", "abcd"]);
	});

	it("never moves queued output ahead of a later resize", async () => {
		const mirror = createMirror(10, 4);
		const widths: number[] = [];
		await new Promise<void>((resolve) => {
			mirror.applyOutput(Buffer.from("first", "utf8"));
			mirror.applyOutput(Buffer.from("x", "utf8"), (screen) => widths.push(screen.cols));
			mirror.resize(20, 4);
			mirror.applyOutput(Buffer.from("y", "utf8"), (screen) => {
				widths.push(screen.cols);
				resolve();
			});
		});

		expect(widths).toEqual([10, 20]);
	});

	it("assigns immutable per-stream cursors only to nonempty output", async () => {
		const mirror = createMirror();
		const initial = (await mirror.getSnapshot())?.outputCursor;
		const first = mirror.applyOutput(Buffer.from("a"));
		const empty = mirror.applyOutput(Buffer.alloc(0));
		const second = mirror.applyOutput(Buffer.from("b"));
		expect(initial).toEqual({ streamId: expect.any(String), sequence: 0 });
		expect(first).toEqual({ streamId: initial?.streamId, sequence: 1 });
		expect(empty).toBe(first);
		expect(second).toEqual({ streamId: initial?.streamId, sequence: 2 });
		expect(Object.isFrozen(first)).toBe(true);
		expect((await mirror.getSnapshot())?.outputCursor).toEqual(second);
		expect((await createMirror().getSnapshot())?.outputCursor.streamId).not.toBe(initial?.streamId);
	});

	it.each([false, true])("captures exact FIFO barriers without later output (batching=%s)", async (batching) => {
		const mirror = createMirror();
		mirror.setBatching(batching);
		const first = mirror.applyOutput(Buffer.from("first"));
		const firstSnapshot = mirror.getSnapshot();
		const second = mirror.applyOutput(Buffer.from("second"));
		const secondSnapshot = mirror.getSnapshot();
		const third = mirror.applyOutput(Buffer.from("third"));
		const thirdSnapshot = mirror.getSnapshot();

		expect(await firstSnapshot).toMatchObject({ snapshot: expect.stringMatching(/first$/), outputCursor: first });
		expect(await secondSnapshot).toMatchObject({
			snapshot: expect.stringMatching(/firstsecond$/),
			outputCursor: second,
		});
		expect(await thirdSnapshot).toMatchObject({
			snapshot: expect.stringMatching(/firstsecondthird$/),
			outputCursor: third,
		});
	});

	it.each([false, true])(
		"renders unsafe output but refuses capture until completion (batching=%s)",
		async (batching) => {
			const mirror = createMirror();
			mirror.setBatching(batching);
			const callback = vi.fn();
			const unsafeCursor = mirror.applyOutput(Buffer.from("visible\u001b[3"), callback, {
				restoreSnapshotSafe: false,
			});
			expect(unsafeCursor?.sequence).toBe(1);
			await expect(mirror.getSnapshot()).rejects.toBeInstanceOf(TerminalRestoreSnapshotUnavailableError);
			expect(callback).toHaveBeenCalledOnce();
			expect(callback.mock.calls[0]?.[0].lines[0]).toBe("visible");

			const safeCursor = mirror.applyOutput(Buffer.from("1mcomplete"), undefined, { restoreSnapshotSafe: true });
			expect(await mirror.getSnapshot()).toMatchObject({
				snapshot: expect.stringContaining("complete"),
				outputCursor: safeCursor,
			});
			const viewer = await restoreViewer(mirror);
			expect(viewer.buffer.active.getLine(0)?.translateToString(true)).toBe("visiblecomplete");
		},
	);

	it.each([false, true])("checks applied safety at each FIFO snapshot boundary (batching=%s)", async (batching) => {
		const mirror = createMirror();
		mirror.setBatching(batching);
		const prefixCursor = mirror.applyOutput(Buffer.from("prefix"));
		const prefixSnapshot = mirror.getSnapshot();
		mirror.applyOutput(Buffer.from("\u001b[3"), undefined, { restoreSnapshotSafe: false });
		const unsafeSnapshot = expect(mirror.getSnapshot()).rejects.toBeInstanceOf(
			TerminalRestoreSnapshotUnavailableError,
		);
		const completeCursor = mirror.applyOutput(Buffer.from("1mcomplete"), undefined, { restoreSnapshotSafe: true });
		const completeSnapshot = mirror.getSnapshot();

		// Both flags have already been accepted before any queued write applies.
		expect(await prefixSnapshot).toMatchObject({
			snapshot: expect.stringMatching(/prefix$/),
			outputCursor: prefixCursor,
		});
		await unsafeSnapshot;
		expect(await completeSnapshot).toMatchObject({
			snapshot: expect.stringContaining("complete"),
			outputCursor: completeCursor,
		});
	});

	it.each([false, true])(
		"uses final safety for each fully rendered coalesced group (batching=%s)",
		async (batching) => {
			const mirror = createMirror();
			mirror.setBatching(batching);
			const screens: string[] = [];
			const onApplied = (screen: { lines: string[] }) => screens.push(screen.lines[0] ?? "");
			mirror.applyOutput(Buffer.from("visible\u001b[3"), onApplied, { restoreSnapshotSafe: false });
			const completed = mirror.applyOutput(Buffer.from("1mcomplete"), onApplied, { restoreSnapshotSafe: true });
			expect(await mirror.getSnapshot()).toMatchObject({ outputCursor: completed });
			expect(screens).toEqual(["visiblecomplete", "visiblecomplete"]);

			mirror.applyOutput(Buffer.from("next"), onApplied, { restoreSnapshotSafe: true });
			mirror.applyOutput(Buffer.from("\u001b[3"), onApplied, { restoreSnapshotSafe: false });
			await expect(mirror.getSnapshot()).rejects.toBeInstanceOf(TerminalRestoreSnapshotUnavailableError);
			expect(screens.slice(2)).toEqual(["visiblecompletenext", "visiblecompletenext"]);
		},
	);

	it.each([false, true])("preserves accepted safety for unannotated system output (batching=%s)", async (batching) => {
		const mirror = createMirror();
		mirror.setBatching(batching);
		mirror.applyOutput(Buffer.from("visible"), undefined, { restoreSnapshotSafe: false });
		// This write arrives before the unsafe group applies. The initial
		// applied safety must not make an unannotated warning falsely safe.
		mirror.applyOutput(Buffer.from("warning"));
		await expect(mirror.getSnapshot()).rejects.toBeInstanceOf(TerminalRestoreSnapshotUnavailableError);
		mirror.applyOutput(Buffer.from("complete"), undefined, { restoreSnapshotSafe: true });
		const finalCursor = mirror.applyOutput(Buffer.from("system"));
		expect(await mirror.getSnapshot()).toMatchObject({
			snapshot: expect.stringMatching(/visiblewarningcompletesystem$/),
			outputCursor: finalCursor,
		});
	});

	it.each([false, true])(
		"queues empty safety updates without advancing the output cursor (batching=%s)",
		async (batching) => {
			const mirror = createMirror();
			mirror.setBatching(batching);
			const cursor = mirror.applyOutput(Buffer.from("visible"), undefined, { restoreSnapshotSafe: false });
			await expect(mirror.getSnapshot()).rejects.toBeInstanceOf(TerminalRestoreSnapshotUnavailableError);
			const callback = vi.fn();
			expect(mirror.applyOutput(Buffer.alloc(0), callback, { restoreSnapshotSafe: true })).toBe(cursor);
			expect(await mirror.getSnapshot()).toMatchObject({
				snapshot: expect.stringMatching(/visible$/),
				outputCursor: cursor,
			});
			expect(callback).toHaveBeenCalledOnce();
		},
	);

	it("uses the final represented cursor for coalesced output while preserving callback order", async () => {
		const mirror = createMirror();
		const screens: string[] = [];
		const callbacks: string[] = [];
		const first = mirror.applyOutput(Buffer.from("a"), (screen) => {
			screens.push(screen.lines[0] ?? "");
			callbacks.push("a");
		});
		const second = mirror.applyOutput(Buffer.from("b"), (screen) => {
			screens.push(screen.lines[0] ?? "");
			callbacks.push("b");
		});
		const captured = mirror.getSnapshot();
		mirror.applyOutput(Buffer.from("c"));
		expect(first?.sequence).toBe(1);
		expect(second?.sequence).toBe(2);
		expect(await captured).toMatchObject({ snapshot: expect.stringMatching(/ab$/), outputCursor: second });
		expect(callbacks).toEqual(["a", "b"]);
		expect(screens).toEqual(["ab", "ab"]);
	});

	it.each([
		[120, 30],
		[120, 24],
		[80, 30],
	])("returns to original geometry after a queued %ix%i resize", async (cols, rows) => {
		const mirror = createMirror();
		const dimensions: number[][] = [];
		mirror.resize(cols, rows);
		mirror.applyOutput(Buffer.from("wide"), (screen) => dimensions.push([screen.cols, screen.rows]));
		mirror.resize(80, 24);
		mirror.applyOutput(Buffer.from("narrow"), (screen) => dimensions.push([screen.cols, screen.rows]));
		expect(await mirror.getSnapshot()).toMatchObject({ cols: 80, rows: 24 });
		expect(dimensions).toEqual([
			[cols, rows],
			[80, 24],
		]);
	});

	it("skips repeated resize targets only after preceding queued geometry applies", async () => {
		const mirror = createMirror();
		const terminal = (mirror as unknown as { terminal: HeadlessTerminal }).terminal;
		const resize = vi.spyOn(terminal, "resize");
		mirror.resize(120, 30);
		mirror.resize(120, 30);
		mirror.resize(80, 24);
		mirror.resize(80, 24);
		expect(await mirror.getSnapshot()).toMatchObject({ cols: 80, rows: 24 });
		expect(resize.mock.calls).toEqual([
			[120, 30],
			[80, 24],
		]);
	});

	it("flushes batched output before resize without moving later batches ahead", async () => {
		const mirror = createMirror(10, 4);
		const widths: number[] = [];
		mirror.setBatching(true);
		const first = mirror.applyOutput(Buffer.from("before"), (screen) => widths.push(screen.cols));
		const before = mirror.getSnapshot();
		mirror.applyOutput(Buffer.from("old"), (screen) => widths.push(screen.cols));
		mirror.resize(20, 4);
		const final = mirror.applyOutput(Buffer.from("new"), (screen) => widths.push(screen.cols));
		const after = mirror.getSnapshot();
		expect(await before).toMatchObject({ snapshot: expect.stringMatching(/before$/), cols: 10, outputCursor: first });
		expect(await after).toMatchObject({
			snapshot: expect.stringMatching(/beforeoldnew$/),
			cols: 20,
			outputCursor: final,
		});
		expect(widths).toEqual([10, 10, 20]);
	});

	it("keeps re-entrant callback output and snapshots behind already queued barriers", async () => {
		const mirror = createMirror();
		const callbacks: string[] = [];
		let reentrantSnapshot: ReturnType<TerminalStateMirror["getSnapshot"]> | undefined;
		mirror.applyOutput(Buffer.from("a"), () => {
			callbacks.push("a");
			mirror.applyOutput(Buffer.from("c"), () => callbacks.push("c"));
			reentrantSnapshot = mirror.getSnapshot();
			mirror.applyOutput(Buffer.from("d"), () => callbacks.push("d"));
		});
		const firstSnapshot = mirror.getSnapshot();
		const second = mirror.applyOutput(Buffer.from("b"), () => callbacks.push("b"));
		const secondSnapshot = mirror.getSnapshot();
		expect(await firstSnapshot).toMatchObject({
			snapshot: expect.stringMatching(/a$/),
			outputCursor: { sequence: 1 },
		});
		expect(await secondSnapshot).toMatchObject({ snapshot: expect.stringMatching(/ab$/), outputCursor: second });
		expect(await reentrantSnapshot).toMatchObject({
			snapshot: expect.stringMatching(/abc$/),
			outputCursor: { sequence: 3 },
		});
		expect(await mirror.getSnapshot()).toMatchObject({
			snapshot: expect.stringMatching(/abcd$/),
			outputCursor: { sequence: 4 },
		});
		expect(callbacks).toEqual(["a", "b", "c", "d"]);
	});

	it.each([false, true])("settles queued snapshots after disposal (batching=%s)", async (batching) => {
		const mirror = createMirror();
		mirror.setBatching(batching);
		const callback = vi.fn();
		mirror.applyOutput(Buffer.from("pending"), callback);
		const snapshot = mirror.getSnapshot();
		mirror.dispose();
		expect(await snapshot).toBeNull();
		expect(await mirror.getSnapshot()).toBeNull();
		expect(mirror.applyOutput(Buffer.from("late"), callback)).toBeNull();
		expect(callback).not.toHaveBeenCalled();
	});

	it("releases in-flight writes on disposal even when xterm never calls back", async () => {
		const mirror = createMirror();
		const terminal = (mirror as unknown as { terminal: HeadlessTerminal }).terminal;
		let complete: (() => void) | undefined;
		vi.spyOn(terminal, "write").mockImplementation((_data, callback) => {
			complete = callback;
		});
		const callback = vi.fn();
		mirror.applyOutput(Buffer.from("pending"), callback);
		const snapshot = mirror.getSnapshot();
		await Promise.resolve();
		expect(complete).toBeTypeOf("function");
		mirror.dispose();
		expect(await snapshot).toBeNull();
		complete?.();
		expect(callback).not.toHaveBeenCalled();
	});

	it("allows a callback to dispose its mirror without invoking later grouped callbacks", async () => {
		const mirror = createMirror();
		const callback = vi.fn();
		mirror.applyOutput(Buffer.from("a"), () => mirror.dispose());
		mirror.applyOutput(Buffer.from("b"), callback);
		expect(await mirror.getSnapshot()).toBeNull();
		expect(callback).not.toHaveBeenCalled();
	});

	it("continues after a throwing applied callback without losing the snapshot barrier", async () => {
		const mirror = createMirror();
		const callback = vi.fn();
		mirror.applyOutput(Buffer.from("a"), () => {
			throw new Error("callback failure");
		});
		const second = mirror.applyOutput(Buffer.from("b"), callback);
		expect(await mirror.getSnapshot()).toMatchObject({
			snapshot: expect.stringMatching(/ab$/),
			outputCursor: second,
		});
		expect(callback).toHaveBeenCalledOnce();
	});

	it("settles a failed serialization and still runs subsequent barriers", async () => {
		const mirror = createMirror();
		const addon = (mirror as unknown as { serializeAddon: { serialize: () => string } }).serializeAddon;
		const serialize = vi.spyOn(addon, "serialize").mockImplementationOnce(() => {
			throw new Error("serialization failure");
		});
		await expect(mirror.getSnapshot()).rejects.toThrow("serialization failure");
		mirror.applyOutput(Buffer.from("recovered"));
		expect(await mirror.getSnapshot()).toMatchObject({
			snapshot: expect.stringMatching(/recovered$/),
			outputCursor: { sequence: 1 },
		});
		expect(serialize).toHaveBeenCalledTimes(2);
	});

	it("retires unknown stream coverage after a synchronous terminal write failure", async () => {
		const mirror = createMirror();
		const terminal = (mirror as unknown as { terminal: HeadlessTerminal }).terminal;
		vi.spyOn(terminal, "write").mockImplementationOnce(() => {
			throw new Error("write failure");
		});
		const callback = vi.fn();
		mirror.applyOutput(Buffer.from("failed"), callback);
		expect(await mirror.getSnapshot()).toBeNull();
		expect(callback).not.toHaveBeenCalled();
		expect(mirror.applyOutput(Buffer.from("later"))).toBeNull();
	});

	it("serializes inline terminal content and dimensions", async () => {
		const mirror = createMirror(100, 30);

		mirror.applyOutput(Buffer.from("hello\r\nworld", "utf8"));

		const snapshot = await mirror.getSnapshot();

		expect(snapshot?.cols).toBe(100);
		expect(snapshot?.rows).toBe(30);
		expect(snapshot?.snapshot).toContain("hello");
		expect(snapshot?.snapshot).toContain("world");
	});

	it("restores normal shell/error output and fullscreen state across subprocess transitions", async () => {
		const mirror = createMirror(40, 8);
		mirror.applyOutput(Buffer.from("shell$ pi\r\nStartup error: invalid option\r\n"));
		const startupViewer = await restoreViewer(mirror);
		expect(startupViewer.buffer.active.type).toBe("normal");
		expect(startupViewer.buffer.normal.getLine(0)?.translateToString(true)).toBe("shell$ pi");
		expect(startupViewer.buffer.normal.getLine(1)?.translateToString(true)).toBe("Startup error: invalid option");

		mirror.applyOutput(Buffer.from("\u001b[?1049h\u001b[H\u001b[?1003;1006hfirst fullscreen frame"));
		mirror.applyOutput(Buffer.from("\u001b[?1003l\u001b[?1049lsubprocess output\r\n"));
		const normalViewer = await restoreViewer(mirror);
		expect(normalViewer.buffer.active.type).toBe("normal");
		expect(normalViewer.modes.mouseTrackingMode).toBe("none");
		expect(normalViewer.buffer.normal.getLine(1)?.translateToString(true)).toBe("Startup error: invalid option");
		expect(normalViewer.buffer.normal.getLine(2)?.translateToString(true)).toBe("subprocess output");

		// Encoding survives while tracking is off; resuming fullscreen only needs to re-enable tracking.
		mirror.applyOutput(Buffer.from("\u001b[?1049h\u001b[H\u001b[?1003hsecond fullscreen frame"));
		const fullscreenViewer = await restoreViewer(mirror);
		expect(fullscreenViewer.buffer.active.type).toBe("alternate");
		expect(fullscreenViewer.modes.mouseTrackingMode).toBe("any");
		expect(fullscreenViewer.buffer.active.getLine(0)?.translateToString(true)).toBe("second fullscreen frame");
		expect(fullscreenViewer.buffer.normal.getLine(2)?.translateToString(true)).toBe("subprocess output");
		expect((await mirror.getSnapshot())?.snapshot).toContain("\u001b[?1006h");
	});

	it("preserves alternate-screen state across the pre-restore resize", async () => {
		const mirror = createMirror();

		mirror.applyOutput(Buffer.from("\u001b[?1049h\u001b[Hbefore resize", "utf8"));
		mirror.resize(120, 40);
		mirror.applyOutput(Buffer.from("\u001b[Hafter resize", "utf8"));

		const snapshot = await mirror.getSnapshot();

		expect(snapshot?.cols).toBe(120);
		expect(snapshot?.rows).toBe(40);
		expect(snapshot?.snapshot).toContain("\u001b[?1049h");
		expect(snapshot?.snapshot).toContain("after resize");
	});

	it("applies queued resizes before generating a snapshot", async () => {
		const mirror = createMirror(80, 24);

		mirror.applyOutput(Buffer.from("before resize", "utf8"));
		mirror.resize(120, 40);
		mirror.applyOutput(Buffer.from("\r\nafter resize", "utf8"));

		const snapshot = await mirror.getSnapshot();

		expect(snapshot?.cols).toBe(120);
		expect(snapshot?.rows).toBe(40);
		expect(snapshot?.snapshot).toContain("after resize");
	});

	it("emits terminal query responses through the optional callback", async () => {
		const onInputResponse = vi.fn();
		const mirror = new TerminalStateMirror(80, 24, {
			onInputResponse,
		});
		mirrors.push(mirror);

		mirror.applyOutput(Buffer.from("\u001b[6n", "utf8"));
		await mirror.getSnapshot();

		expect(onInputResponse).toHaveBeenCalledWith("\u001b[1;1R");
	});

	it.each([1006, 1016])("preserves mouse encoding %i with tracking across restore", async (mode) => {
		const mirror = createMirror();
		// Exercise parser state across chunks and the detached batching path.
		mirror.setBatching(true);
		mirror.applyOutput(Buffer.from("\u001b[?1003;"));
		mirror.applyOutput(Buffer.from(`${mode}h`));
		const snapshot = await mirror.getSnapshot();
		expect(snapshot?.snapshot).toContain("\u001b[?1003h");
		expect(snapshot?.snapshot).toContain(`\u001b[?${mode}h`);
		if (!snapshot) throw new Error("Expected a live mirror snapshot");

		const restored = createMirror();
		restored.applyOutput(Buffer.from(snapshot.snapshot));
		expect((await restored.getSnapshot())?.snapshot).toBe(snapshot?.snapshot);
	});

	it.each([
		["\u001b[?1006h\u001b[?1006l", 0],
		["\u001b[?1016h\u001b[?1006l", 0],
		["\u001b[?1006h\u001b[?1016l", 0],
		["\u001b[?1006;1016h", 1016],
		["\u001b[?1016;1006h", 1006],
		["\u001b[?1006h\u001bc", 0],
		["\u001b[?1006h\u001bc\u001b[?1016h", 1016],
		["\u001b[?1006h\u001b[!p", 1006],
		["\u001b[?1006h\u001b[?1003l", 1006],
	])("tracks encoding changes and resets in %j", async (output, mode) => {
		const mirror = createMirror();
		mirror.applyOutput(Buffer.from(output));
		const result = await mirror.getSnapshot();
		if (!result) throw new Error("Expected a live mirror snapshot");
		const snapshot = result.snapshot;
		expect(snapshot.includes("\u001b[?1006h")).toBe(mode === 1006);
		expect(snapshot.includes("\u001b[?1016h")).toBe(mode === 1016);
	});
});
