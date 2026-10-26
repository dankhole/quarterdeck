// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import { TerminalWheelTransport } from "./terminal-wheel-transport";

const down = "\x1b[<65;12;15M";
const up = "\x1b[<64;120;150M";
const legacy = "\x1b[M\x61\xfe\xff";

function bytes(data: string): Uint8Array {
	return Uint8Array.from(data, (char) => char.charCodeAt(0));
}

describe("one-wheel transport", () => {
	it("writes complete encoded reports once, synchronously, in their original order", () => {
		const send = vi.fn();
		const transport = new TerminalWheelTransport(send);
		transport.batchWheelReports(() => {
			transport.forward(down);
			transport.forward(up);
			expect(send).not.toHaveBeenCalled();
		});
		expect(send.mock.calls).toEqual([[down + up]]);
		transport.batchWheelReports(() => transport.forward(down));
		expect(send.mock.calls).toEqual([[down + up], [down]]);
	});

	it("preserves legacy binary bytes rather than UTF-8 encoding them", () => {
		const send = vi.fn();
		const transport = new TerminalWheelTransport(send);
		transport.batchWheelReports(() => {
			transport.forward(legacy, true);
			transport.forward(legacy, true);
		});
		expect(send.mock.calls).toEqual([[bytes(legacy + legacy)]]);
	});

	it.each([
		"text",
		"日本語",
		"\x1b[200~paste\r\ntext\x1b[201~",
		"\r",
		"\x03",
		"\x1b",
		"\x1b[<0;12;15M",
		"\x1b[<0;12;15m",
		"\x1b[<32;12;15M",
		"\x1b[<69;12;15M",
		"\x1b[1;1R",
		"\x1b[?1;2c",
		"\x1b[I",
		"\x1b]52;c;\x07",
		"\x1bP!|reply\x1b\\",
		"\x1b[<65;12;",
		"15M",
		down + down,
		`${down}\n`,
		`${down}\r\n`,
	])("keeps ordinary or unrelated input %j immediate and separate even during reentrancy", (data) => {
		const send = vi.fn();
		const transport = new TerminalWheelTransport(send);
		transport.forward(data);
		transport.forward(data);
		expect(send.mock.calls).toEqual([[data], [data]]);
		send.mockClear();
		transport.batchWheelReports(() => {
			transport.forward(down);
			transport.forward(data);
			expect(send.mock.calls).toEqual([[down], [data]]);
			transport.forward(up);
		});
		expect(send.mock.calls).toEqual([[down], [data], [up]]);
	});

	it("does not batch even wheel-shaped input outside the physical wheel scope", () => {
		const send = vi.fn();
		const transport = new TerminalWheelTransport(send);
		transport.forward(down);
		transport.forward(down);
		expect(send.mock.calls).toEqual([[down], [down]]);
	});

	it("does not mix binary and text frames if encoding changes synchronously", () => {
		const send = vi.fn();
		const transport = new TerminalWheelTransport(send);
		transport.batchWheelReports(() => {
			transport.forward(legacy, true);
			transport.forward(down);
			transport.forward(legacy, true);
		});
		expect(send.mock.calls).toEqual([[bytes(legacy)], [down], [bytes(legacy)]]);
	});

	it("does not send for an empty wheel and does not defer later input", () => {
		const send = vi.fn();
		const transport = new TerminalWheelTransport(send);
		transport.batchWheelReports(() => {});
		expect(send).not.toHaveBeenCalled();
		transport.forward("next");
		expect(send.mock.calls).toEqual([["next"]]);
	});

	it("flushes completed reports on dispatch failure and resets scope", () => {
		const send = vi.fn();
		const transport = new TerminalWheelTransport(send);
		expect(() =>
			transport.batchWheelReports(() => {
				transport.forward(down);
				throw new Error("dispatch");
			}),
		).toThrow("dispatch");
		transport.forward(up);
		expect(send.mock.calls).toEqual([[down], [up]]);
	});

	it("does not retain or replay reports after a failed transport write", () => {
		const send = vi.fn().mockImplementationOnce(() => {
			throw new Error("send");
		});
		const transport = new TerminalWheelTransport(send);
		expect(() => transport.batchWheelReports(() => transport.forward(down))).toThrow("send");
		transport.forward(up);
		expect(send.mock.calls).toEqual([[down], [up]]);
	});

	it("keeps nested physical wheels separate and restores the outer scope", () => {
		const send = vi.fn();
		const transport = new TerminalWheelTransport(send);
		transport.batchWheelReports(() => {
			transport.forward(down);
			transport.batchWheelReports(() => {
				transport.forward(up);
				transport.forward(up);
			});
			transport.forward(down);
		});
		expect(send.mock.calls).toEqual([[down], [up + up], [down]]);
	});

	it("clears pending reports before invoking a reentrant transport callback", () => {
		const send = vi.fn((data: string | Uint8Array) => {
			if (data === down) transport.batchWheelReports(() => transport.forward(up));
		});
		const transport = new TerminalWheelTransport(send);
		transport.batchWheelReports(() => transport.forward(down));
		expect(send.mock.calls).toEqual([[down], [up]]);
	});

	it("drops pending reports on disposal and never revives the scope", () => {
		const send = vi.fn();
		const transport = new TerminalWheelTransport(send);
		transport.batchWheelReports(() => {
			transport.forward(down);
			transport.dispose();
			transport.forward(up);
		});
		const dispatch = vi.fn();
		transport.batchWheelReports(dispatch);
		transport.forward("later");
		expect(send).not.toHaveBeenCalled();
		expect(dispatch).not.toHaveBeenCalled();
	});
});
