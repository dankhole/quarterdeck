import upstreamModule from "@xterm/addon-serialize";
import headlessModule, { type Terminal as HeadlessTerminal, type IBuffer, type IBufferCell } from "@xterm/headless";
import { afterEach, describe, expect, it } from "vitest";

import { SerializeAddon } from "../../../src/terminal/xterm-serialize";

const { Terminal } = headlessModule as { Terminal: typeof HeadlessTerminal };
const { SerializeAddon: UpstreamSerializeAddon } = upstreamModule;
const terminals: HeadlessTerminal[] = [];
const close = "\u001b]8;;\u001b\\";
const open = (uri: string, id = "") => `\u001b]8;${id ? `id=${id}` : ""};${uri}\u001b\\`;
const link = (label: string, uri = "https://example.test/one", id = "") => open(uri, id) + label + close;

function terminal(cols = 12, rows = 4, scrollback = 100): HeadlessTerminal {
	const result = new Terminal({ allowProposedApi: true, cols, rows, scrollback, scrollOnEraseInDisplay: true });
	terminals.push(result);
	return result;
}

function write(target: HeadlessTerminal, data: string): Promise<void> {
	return new Promise((resolve) => target.write(data, resolve));
}

// Independent roundtrip oracle: inspect actual xterm cells and resolved OSC
// metadata, not the serialized escape strings or serializer's own helper.
function cellLink(target: HeadlessTerminal, cell: IBufferCell): { id?: string; uri: string } | undefined {
	const linked = cell as IBufferCell & { extended: { urlId: number } };
	const internal = target as unknown as {
		_core: { _oscLinkService: { getLinkData(id: number): { id?: string; uri: string } | undefined } };
	};
	return linked.extended.urlId ? internal._core._oscLinkService.getLinkData(linked.extended.urlId) : undefined;
}

function bufferState(target: HeadlessTerminal, buffer: IBuffer) {
	return {
		cursorX: buffer.cursorX,
		cursorY: buffer.cursorY,
		baseY: buffer.baseY,
		lines: Array.from({ length: buffer.length }, (_, row) => {
			const line = buffer.getLine(row);
			return {
				wrapped: line?.isWrapped,
				cells: Array.from({ length: target.cols }, (_, col) => {
					const cell = line?.getCell(col);
					if (!cell) return undefined;
					return {
						chars: cell.getChars(),
						width: cell.getWidth(),
						link: cellLink(target, cell),
						fg: [cell.getFgColorMode(), cell.getFgColor()],
						bg: [cell.getBgColorMode(), cell.getBgColor()],
						flags: [
							cell.isBold(),
							cell.isItalic(),
							cell.isDim(),
							cell.isUnderline(),
							cell.isOverline(),
							cell.isBlink(),
							cell.isInverse(),
							cell.isInvisible(),
							cell.isStrikethrough(),
						],
					};
				}),
			};
		}),
	};
}

function expectSame(source: HeadlessTerminal, restored: HeadlessTerminal): void {
	expect(restored.buffer.active.type).toBe(source.buffer.active.type);
	expect(bufferState(restored, restored.buffer.normal)).toEqual(bufferState(source, source.buffer.normal));
	if (source.buffer.active.type === "alternate") {
		expect(bufferState(restored, restored.buffer.alternate)).toEqual(bufferState(source, source.buffer.alternate));
	}
	expect(restored.modes).toEqual(source.modes);
}

async function restore(source: HeadlessTerminal): Promise<{ restored: HeadlessTerminal; snapshot: string }> {
	const serializer = new SerializeAddon();
	source.loadAddon(serializer);
	const snapshot = serializer.serialize();
	const restored = terminal(source.cols, source.rows, source.options.scrollback);
	await write(restored, snapshot);
	expectSame(source, restored);
	return { restored, snapshot };
}

afterEach(() => {
	for (const target of terminals.splice(0)) target.dispose();
});

function continuationState(target: HeadlessTerminal) {
	const { _charsetService, _bufferService } = (
		target as unknown as {
			_core: {
				_charsetService: { _charsets: unknown[]; glevel: number; charset: unknown };
				_bufferService: {
					buffers: {
						normal: { scrollTop: number; scrollBottom: number };
						alt: { scrollTop: number; scrollBottom: number };
					};
				};
			};
		}
	)._core;
	return {
		charsets: Array.from({ length: 4 }, (_, index) => _charsetService._charsets[index]),
		level: _charsetService.glevel,
		active: _charsetService.charset,
		margins: [_bufferService.buffers.normal, _bufferService.buffers.alt].map(({ scrollTop, scrollBottom }) => [
			scrollTop,
			scrollBottom,
		]),
	};
}

async function expectContinuation(source: HeadlessTerminal, restored: HeadlessTerminal, suffix: string): Promise<void> {
	await write(source, suffix);
	await write(restored, suffix);
	expectSame(source, restored);
	expect(continuationState(restored)).toEqual(continuationState(source));
}

describe("xterm 6 persistent continuation state", () => {
	it("restores DEC line drawing selected before a snapshot without replaying that selection", async () => {
		const source = terminal();
		await write(source, "\u001b(0");
		const { restored, snapshot } = await restore(source);
		expect(snapshot).not.toBe("");
		await expectContinuation(source, restored, "q");
		expect(restored.buffer.active.getLine(0)?.translateToString(true)).toBe("─");
	});

	it.each(["0", "A", "B", "4", "C", "5", "R", "Q", "K", "Y", "E", "6", "Z", "H", "7", "="])(
		"roundtrips the pinned charset map and aliases: %s",
		async (designation) => {
			const source = terminal(80, 4);
			await write(source, `\u001b(${designation}`);
			const { restored } = await restore(source);
			expect(continuationState(restored)).toEqual(continuationState(source));
			await expectContinuation(source, restored, "#@[\\]^_`abcdefghijklmnopqrstuvwxyz{|}~");
		},
	);

	it.each(["\u000f", "\u000e", "\u001bn", "\u001bo"])(
		"preserves all designations and active GL: %j",
		async (select) => {
			const source = terminal(80, 4);
			await write(source, `before\u001b(A\u001b)0\u001b*K\u001b+R${select}`);
			const { restored } = await restore(source);
			expect(continuationState(restored)).toEqual(continuationState(source));
			await expectContinuation(source, restored, "#q@[\u000f#q@[\u000e#q@[\u001bn#q@[\u001bo#q@[");
		},
	);

	it("preserves a DECRC charset distinct from its designated GL slot", async () => {
		const source = terminal();
		await write(source, "\u001b(0\u001b7\u001b(B\u001b8");
		const { restored } = await restore(source);
		expect(continuationState(restored)).toEqual(continuationState(source));
		await expectContinuation(source, restored, "q\u000fq");
		expect(restored.buffer.active.getLine(0)?.translateToString(true)).toBe("─q");
	});

	it("does not overwrite the saved cursor/style when restoring a detached DECRC charset", async () => {
		const source = terminal(20, 6);
		await write(source, "\u001b[2;3H\u001b(0\u001b[31m\u001b7\u001b(B\u001b8\u001b[3;4H\u001b[34mqq");
		const { restored } = await restore(source);
		await expectContinuation(source, restored, "z\u001b8q\u000fQ");
	});

	it("recovers pending wrap with a detached charset whose printed ASCII needs inverse mapping", async () => {
		const source = terminal(12, 4);
		await write(source, `\u001b(4\u001b7\u001b(B\u001b8${"]".repeat(12)}`);
		expect(source.buffer.active.cursorX).toBe(12);
		const { restored } = await restore(source);
		await expectContinuation(source, restored, "q\u000fq");
	});

	it("rejects an inherited detached charset rather than emitting an unfaithful save slot", async () => {
		const source = terminal();
		await write(source, "\u001b(0\u001b7\u001b(B\u001b8\u001b[?47h");
		const serializer = new SerializeAddon();
		source.loadAddon(serializer);
		expect(() => serializer.serialize()).toThrow("Unsupported xterm 6 inherited detached charset");
	});

	it.each(["\u001b%G", "\u001b%@", "\u001b[?2h", "\u001b[!p", "\u001bc"])(
		"captures reset/default charset state: %j",
		async (reset) => {
			const source = terminal(40, 4);
			await write(source, `\u001b(A\u001b)0\u001b*K\u001b+R\u001bo\u001b[2;3r${reset}`);
			const { restored } = await restore(source);
			expect(continuationState(restored)).toEqual(continuationState(source));
			await expectContinuation(source, restored, "#q\u000e#q\u001bn#q\u001bo#q");
		},
	);

	it("retains scrolling margins so subsequent linefeed does not overwrite outside rows", async () => {
		const source = terminal(20, 4);
		await write(source, "top\r\nmiddle\r\nbottom\r\nlast\u001b[2;3r\u001b[3;1H");
		const { restored } = await restore(source);
		expect(continuationState(restored)).toEqual(continuationState(source));
		await expectContinuation(source, restored, "\nX");
		expect(
			Array.from({ length: 4 }, (_, index) => restored.buffer.active.getLine(index)?.translateToString(true)),
		).toEqual(["top", "bottom", "X", "last"]);
	});

	it.each([
		{ alternate: false, origin: false },
		{ alternate: false, origin: true },
		{ alternate: true, origin: false },
		{ alternate: true, origin: true },
	])("restores each buffer's margins, DECOM and cursor ($alternate, $origin)", async ({ alternate, origin }) => {
		const source = terminal(20, 6);
		await write(source, "N0\r\nN1\r\nN2\r\nN3\r\nN4\r\nN5\u001b[2;5r\u001b[3;4H\u001b(0");
		if (alternate) await write(source, "\u001b[?1049h\u001b(B\u001b[HA0\r\nA1\r\nA2\r\nA3\r\nA4\r\nA5\u001b[3;4r");
		await write(source, `${origin ? "\u001b[?6h" : ""}\u001b[2;7H`);
		const { restored } = await restore(source);
		expect(continuationState(restored)).toEqual(continuationState(source));
		await expectContinuation(source, restored, "q\nX\u001bM");
		if (alternate) await expectContinuation(source, restored, "\u001b[?1049lq\nN");
	});

	it.each([1, 6])("keeps an absolute cursor outside the scrolling region at row %i", async (row) => {
		const source = terminal(20, 6);
		await write(source, `body\u001b[2;5r\u001b[${row};7H`);
		const { restored } = await restore(source);
		await expectContinuation(source, restored, "X\u001bM\nY");
	});

	it.each([false, true])(
		"preserves styled/linked pending wrap after margin/cursor restoration (origin=%s)",
		async (origin) => {
			const source = terminal(12, 4);
			await write(
				source,
				`\u001b[2;3r${origin ? "\u001b[?6h" : ""}\u001b[${origin ? 2 : 3};1H\u001b[31m${open("https://example.test/wrap")}1234567890漢${close}\u001b[32m`,
			);
			expect(source.buffer.active.cursorX).toBe(12);
			const { restored } = await restore(source);
			await expectContinuation(source, restored, "X\r\nY");
		},
	);

	it.each(["charset", "GL", "margins"])("rejects an incompatible private %s shape explicitly", async (field) => {
		const source = terminal();
		const serializer = new SerializeAddon();
		source.loadAddon(serializer);
		const core = (
			source as unknown as {
				_core: {
					_charsetService: { charset: unknown; glevel: unknown };
					_bufferService: { buffers: { normal: { scrollTop: unknown } } };
				};
			}
		)._core;
		if (field === "charset") core._charsetService.charset = { q: "\u001b[2J" };
		else if (field === "GL") core._charsetService.glevel = 4;
		else core._bufferService.buffers.normal.scrollTop = -1;
		expect(() => serializer.serialize()).toThrow("Unsupported xterm 6");
	});
});

describe("xterm 6 OSC 8 string serialization", () => {
	it("preserves the untouched empty snapshot sentinel", () => {
		const source = terminal();
		const serializer = new SerializeAddon();
		source.loadAddon(serializer);
		expect(serializer.serialize()).toBe("");
	});

	it.each([
		["mode-only", "\u001b[?2004h"],
		["open-link-only", open("https://example.test/open")],
	])("does not mistake meaningful empty-terminal state for an empty snapshot: %s", async (_name, output) => {
		const source = terminal();
		await write(source, output);
		const { restored, snapshot } = await restore(source);
		expect(snapshot.length).toBeGreaterThan(0);
		await write(source, `x${close} plain`);
		await write(restored, `x${close} plain`);
		expectSame(source, restored);
	});

	it.each([
		["alternate-screen clear", `\u001b[?1049h${open("https://example.test/disposed")}A\u001b[2JB${close}`],
		["trimmed link marker", `${open("https://example.test/disposed")}A${"\r\n".repeat(130)}B${close}`],
	])("roundtrips retained content after a legitimately disposed link: %s", async (_name, output) => {
		const source = terminal();
		await write(source, output);
		const sourceCell = source.buffer.active
			.getLine(source.buffer.active.baseY + source.buffer.active.cursorY)
			?.getCell(source.buffer.active.cursorX - 1);
		if (!sourceCell) throw new Error("Expected retained content");
		expect(sourceCell.getChars()).toBe("B");
		expect(cellLink(source, sourceCell)).toBeUndefined();
		await restore(source);
	});

	it.each([
		["synthetic underline only", "", false],
		["explicit underline", "\u001b[4m", true],
	] as const)("restores disposed-link cursor style: %s", async (_name, style, underlined) => {
		const source = terminal();
		await write(source, `\u001b[?1049h${style}${open("https://example.test/disposed")}A\u001b[2JB`);
		const { restored } = await restore(source);
		await write(source, `${close}C`);
		await write(restored, `${close}C`);
		expectSame(source, restored);
		const cell = restored.buffer.active.getLine(0)?.getCell(2);
		expect(cell?.getChars()).toBe("C");
		expect(Boolean(cell?.isUnderline())).toBe(underlined);
		if (!cell) throw new Error("Expected live continuation cell");
		expect(cellLink(restored, cell)).toBeUndefined();
	});

	it.each([null, { uri: 42 }])("still rejects incompatible link-service data: %j", async (data) => {
		const source = terminal();
		await write(source, link("label"));
		const serializer = new SerializeAddon();
		source.loadAddon(serializer);
		const internal = source as unknown as { _core: { _oscLinkService: { getLinkData(id: number): unknown } } };
		const service = internal._core._oscLinkService;
		const original = service.getLinkData;
		try {
			service.getLinkData = () => data;
			expect(() => serializer.serialize()).toThrow("Unsupported xterm 6");
		} finally {
			service.getLinkData = original;
		}
	});

	it("does not multiply a large URI across nonprinting padding and CRLF", async () => {
		const source = terminal(12, 4, 1100);
		const uri = `https://example.test/${"u".repeat(10_000)}`;
		const output = `${open(uri)}${"x\r\n".repeat(1000)}${close}`;
		await write(source, output);
		const { snapshot } = await restore(source);
		expect(source.buffer.normal.length).toBe(1001);
		expect(snapshot.split(uri)).toHaveLength(2);
		expect(snapshot.length).toBeLessThan(output.length + 100);
	});

	it.each([
		["normal", `${link("label")} plain ${link("label", "https://example.test/two")}!`],
		[
			"adjacent repeated labels",
			`${link("same", "https://example.test/a")}${link("same", "https://example.test/b")}`,
		],
		[
			"distinct ids",
			`${link("same", "https://example.test/a", "first")}${link("same", "https://example.test/a", "second")}`,
		],
		["linked spaces", `${link("  A  ")}x`],
		["wide and combining", `xx${link("漢字e\u0301 🦊漢字")}plain`],
		[
			"retained scrollback",
			Array.from({ length: 12 }, (_, i) => `${link(`row-${i}`, `https://example.test/${i}`)}\r\n`).join(""),
		],
		["alternate", `${link("normal")}\u001b[?1049h\u001b[H${link("alternate", "https://example.test/alt")} plain`],
		["alternate then return", `${link("normal")}\u001b[?1049h${link("alt")}\u001b[?1049l plain`],
		["overwrite", `${link("original")}\rXX\u001b[3G${link("new", "https://example.test/new")}\u001b[K`],
		["erase", `${link("original")}\r\u001b[2X\u001b[5G\u001b[K`],
		["synthetic wrap repair", `${link("abcdefghijklmnopqrstuv")}\u001b[1;8H\u001b[K\u001b[2;4H`],
		["wide wrap repair", `12345678901${link("漢字next")}\u001b[1;10H\u001b[K`],
		["background and styles", `\u001b[1;3;38;2;12;34;56;48;5;23m${link("styled")}\u001b[0m plain\u001b[44m\u001b[K`],
	])("roundtrips actual cells and URI metadata: %s", async (_name, output) => {
		const source = terminal();
		await write(source, output);
		await restore(source);
	});

	it("retains normal-buffer link targets when a restored alternate buffer returns", async () => {
		const source = terminal(20, 5);
		await write(
			source,
			`${link("normal")}\r\nkept\u001b[?1049h\u001b[H${link("alternate", "https://example.test/alt")}`,
		);
		const { restored } = await restore(source);
		await write(source, "\u001b[?1049l plain");
		await write(restored, "\u001b[?1049l plain");
		expectSame(source, restored);
		expect(cellLink(restored, restored.buffer.normal.getLine(0)?.getCell(0) as IBufferCell)?.uri).toBe(
			"https://example.test/one",
		);
	});

	it("does not mutate source hyperlink attributes while normalizing SGR", async () => {
		const source = terminal();
		await write(source, `${open("https://example.test/one")}\u001b[4mA\u001b[1mB\u001b[0mC`);
		const before = bufferState(source, source.buffer.active);
		const { restored } = await restore(source);
		expect(bufferState(source, source.buffer.active)).toEqual(before);
		await write(source, `${close}D`);
		await write(restored, `${close}D`);
		expectSame(source, restored);
	});

	it("retains links through shrink/grow reflow before and after restore", async () => {
		const source = terminal(20, 5);
		await write(
			source,
			`${link("long label 漢字 e\u0301 repeated words")}${link("same", "https://example.test/two")} plain`,
		);
		source.resize(9, 5);
		const { restored } = await restore(source);
		for (const cols of [25, 8, 20]) {
			source.resize(cols, 5);
			restored.resize(cols, 5);
			expectSame(source, restored);
		}
	});

	it("restores an open hyperlink and current cursor/style for the live suffix", async () => {
		const source = terminal(30, 5);
		await write(
			source,
			`${link("old", "https://example.test/old")}\u001b[2;4H\u001b[1;3;38;2;20;40;60m${open("https://example.test/open", "active")}A`,
		);
		const { restored } = await restore(source);
		const suffix = `BC${close}D\u001b[0mE`;
		await write(source, suffix);
		await write(restored, suffix);
		expectSame(source, restored);
		expect(cellLink(restored, restored.buffer.active.getLine(1)?.getCell(4) as IBufferCell)?.uri).toBe(
			"https://example.test/open",
		);
		expect(cellLink(restored, restored.buffer.active.getLine(1)?.getCell(6) as IBufferCell)).toBeUndefined();
	});

	it("does not leak a previous viewer hyperlink into unlinked or erased cells", async () => {
		const source = terminal();
		await write(source, `plain ${link("link")}!`);
		const serializer = new SerializeAddon();
		source.loadAddon(serializer);
		const restored = terminal();
		await write(restored, open("https://stale.test"));
		await write(restored, serializer.serialize());
		expectSame(source, restored);
		await write(source, "suffix");
		await write(restored, "suffix");
		expectSame(source, restored);
	});

	it("keeps serialization proportional to linked runs rather than cells", async () => {
		const source = terminal(80, 20);
		await write(source, link("x".repeat(1200)));
		const { snapshot } = await restore(source);
		expect(snapshot.split("https://example.test/one")).toHaveLength(2);
		expect(snapshot.length).toBeLessThan(1400);
	});

	it("retains upstream non-link buffer/cursor/mode serialization behavior", async () => {
		const source = terminal();
		await write(source, "\u001b[31mhello\r\nworld\u001b[?1049h\u001b[2;3H\u001b[44mALT\u001b[?2004h\u001b[?1003h");
		const patched = new SerializeAddon();
		const upstream = new UpstreamSerializeAddon();
		source.loadAddon(patched);
		// The browser addon consumes the same structural headless public API.
		upstream.activate(source as unknown as Parameters<typeof upstream.activate>[0]);
		expect(patched.serialize().split(close).join("")).toBe(upstream.serialize());
	});
});
