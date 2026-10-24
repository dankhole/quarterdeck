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
