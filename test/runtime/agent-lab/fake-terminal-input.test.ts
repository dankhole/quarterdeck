import { createInterface } from "node:readline";
import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createFakeAgentTerminalInput } from "../../../scripts/agent-lab/fake-agent-protocol";

const prefix = "\u001b]52;c;";
const encoded = Buffer.from("synthetic clipboard").toString("base64");
const response = `${prefix}${encoded}\u0007`;

function fixture() {
	const source = Object.assign(new PassThrough(), { setRawMode: vi.fn() });
	let pendingReads = 0;
	const onClipboardRead = vi.fn(() => {
		pendingReads--;
	});
	const input = createFakeAgentTerminalInput(source, {
		hasPendingClipboardRead: () => pendingReads > 0,
		onClipboardRead,
	});
	let text = "";
	input.on("data", (chunk: Buffer) => {
		text += chunk.toString("utf8");
	});
	return {
		source,
		input,
		onClipboardRead,
		arm: (count = 1) => {
			pendingReads += count;
		},
		text: () => text,
	};
}

afterEach(() => vi.useRealTimers());

describe("fake provider terminal reply boundary", () => {
	it("removes multiple clipboard replies but preserves surrounding commands and other escape sequences", () => {
		const f = fixture();
		f.arm(2);
		f.source.write(`/local-action before\n${response}${response}\u001b[A/turn-interrupted\n`);
		expect(f.text()).toBe("/local-action before\n\u001b[A/turn-interrupted\n");
		expect(f.onClipboardRead.mock.calls).toEqual([[encoded], [encoded]]);
		f.source.end();
	});

	it.each(Array.from({ length: response.length - 1 }, (_, index) => index + 1))(
		"consumes a clipboard response split after byte %i without leaking it into Readline",
		(split) => {
			const f = fixture();
			f.arm();
			f.source.write(response.slice(0, split));
			f.source.write(`${response.slice(split)}/turn-interrupted\n`);
			expect(f.text()).toBe("/turn-interrupted\n");
			expect(f.onClipboardRead).toHaveBeenCalledExactlyOnceWith(encoded);
			f.source.end();
		},
	);

	it("accepts a split ST terminator as well as BEL", () => {
		const f = fixture();
		f.arm();
		f.source.write(`${prefix}${encoded}\u001b`);
		f.source.write("\\/local-action next\n");
		expect(f.text()).toBe("/local-action next\n");
		expect(f.onClipboardRead).toHaveBeenCalledExactlyOnceWith(encoded);
		f.source.end();
	});

	it("preserves Unicode input split within a UTF-8 code point", () => {
		const f = fixture();
		const bytes = Buffer.from("› synthetic input\n");
		f.source.write(bytes.subarray(0, 1));
		f.source.write(bytes.subarray(1));
		expect(f.text()).toBe("› synthetic input\n");
		f.source.end();
	});

	it.each([false, true])(
		"preserves Readline's 30ms Escape-then-command probe after a completed query: %s",
		async (afterReply) => {
			const f = fixture();
			if (afterReply) {
				f.arm();
				f.source.write(response);
			}
			const output = new PassThrough();
			output.resume();
			const terminal = createInterface({ input: f.input, output, terminal: true, escapeCodeTimeout: 25 });
			const lines: string[] = [];
			terminal.on("line", (line) => lines.push(line));
			try {
				f.source.write("\u001b");
				// This synchronous assertion makes the regression deterministic even
				// if a busy host services the following 30ms timer late.
				expect(f.text()).toBe("\u001b");
				await new Promise((resolve) => setTimeout(resolve, 30));
				f.source.write("/clipboard-read\n");
				expect(lines).toEqual(["/clipboard-read"]);
			} finally {
				terminal.close();
				f.source.end();
				output.destroy();
			}
		},
	);

	it("does not consume unsolicited OSC input or buffer ordinary Escape", () => {
		const f = fixture();
		f.source.write(response);
		f.source.write("\u001b");
		expect(f.text()).toBe(`${response}\u001b`);
		expect(f.onClipboardRead).not.toHaveBeenCalled();
		f.source.end();
	});

	it("bounds partial-prefix buffering only while a query is outstanding", async () => {
		vi.useFakeTimers();
		const f = fixture();
		f.arm();
		f.source.write("\u001b");
		expect(f.text()).toBe("");
		await vi.advanceTimersByTimeAsync(25);
		expect(f.text()).toBe("\u001b");
		f.source.write(response);
		f.source.write("\u001b");
		expect(f.text()).toBe("\u001b\u001b");
		expect(f.onClipboardRead).toHaveBeenCalledExactlyOnceWith(encoded);
		f.source.end();
	});

	it("immediately forwards an Escape in the same chunk after the last expected reply", () => {
		const f = fixture();
		f.arm();
		f.source.write(`${response}\u001b`);
		expect(f.text()).toBe("\u001b");
		expect(f.onClipboardRead).toHaveBeenCalledExactlyOnceWith(encoded);
		f.source.end();
	});

	it("discards an oversized response through its terminator without contaminating the next command", () => {
		const f = fixture();
		f.arm();
		f.source.write(prefix + "A".repeat(5000));
		f.source.write("A".repeat(5000));
		f.source.write("\u0007/turn-interrupted\n");
		expect(f.text()).toBe("/turn-interrupted\n");
		expect(f.onClipboardRead).toHaveBeenCalledExactlyOnceWith(null);
		f.source.write("\u001b");
		expect(f.text()).toBe("/turn-interrupted\n\u001b");
		f.source.end();
	});

	it("delegates raw-mode ownership to the actual PTY and ends with its source", async () => {
		const f = fixture();
		f.input.setRawMode(true);
		f.input.setRawMode(false);
		expect(f.source.setRawMode.mock.calls).toEqual([[true], [false]]);
		const ended = new Promise<void>((resolve) => f.input.once("end", resolve));
		f.source.end();
		await ended;
	});
});
