import headlessModule, { type Terminal as HeadlessTerminal } from "@xterm/headless";
import { afterEach, describe, expect, it, vi } from "vitest";

import { TerminalStateMirror } from "../../../src/terminal";

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
		expect(snapshot).toEqual({ snapshot: "", cols: 80, rows: 24 });
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
