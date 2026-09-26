import { afterEach, describe, expect, it, vi } from "vitest";

import { TerminalStateMirror } from "../../../src/terminal";

const mirrors: TerminalStateMirror[] = [];

function createMirror(cols = 80, rows = 24): TerminalStateMirror {
	const mirror = new TerminalStateMirror(cols, rows);
	mirrors.push(mirror);
	return mirror;
}

afterEach(() => {
	while (mirrors.length > 0) {
		mirrors.pop()?.dispose();
	}
});

describe("TerminalStateMirror", () => {
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

	it("serializes inline terminal content and dimensions", async () => {
		const mirror = createMirror(100, 30);

		mirror.applyOutput(Buffer.from("hello\r\nworld", "utf8"));

		const snapshot = await mirror.getSnapshot();

		expect(snapshot?.cols).toBe(100);
		expect(snapshot?.rows).toBe(30);
		expect(snapshot?.snapshot).toContain("hello");
		expect(snapshot?.snapshot).toContain("world");
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
