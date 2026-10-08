import { describe, expect, it } from "vitest";
import { stripAnsi } from "../../src/terminal/output-utils";

describe("stripAnsi", () => {
	it("returns plain text unchanged", () => {
		expect(stripAnsi("hello world")).toBe("hello world");
	});

	it("returns empty string for empty input", () => {
		expect(stripAnsi("")).toBe("");
	});

	it("strips CSI sequences (e.g. color codes)", () => {
		expect(stripAnsi("\x1b[31mred\x1b[0m")).toBe("red");
	});

	it("strips multiple CSI sequences", () => {
		expect(stripAnsi("\x1b[1m\x1b[34mbold blue\x1b[0m normal")).toBe("bold blue normal");
	});

	it("strips CSI cursor movement sequences", () => {
		expect(stripAnsi("abc\x1b[2Kdef")).toBe("abcdef");
	});

	it("strips CSI sequences with numeric parameters", () => {
		expect(stripAnsi("\x1b[38;5;196mcolored\x1b[0m")).toBe("colored");
	});

	it("strips OSC sequences terminated by BEL", () => {
		expect(stripAnsi("\x1b]0;window title\x07visible")).toBe("visible");
	});

	it("strips OSC sequences terminated by ST (ESC backslash)", () => {
		expect(stripAnsi("\x1b]0;window title\x1b\\visible")).toBe("visible");
	});

	it("strips mixed CSI and OSC sequences", () => {
		expect(stripAnsi("\x1b]0;title\x07\x1b[32mgreen\x1b[0m")).toBe("green");
	});

	it("handles bare ESC followed by unknown character", () => {
		expect(stripAnsi("\x1b?text")).toBe("text");
	});

	it("preserves newlines and tabs", () => {
		expect(stripAnsi("\x1b[31mline1\nline2\t\x1b[0m")).toBe("line1\nline2\t");
	});

	it("handles consecutive escape sequences with no text between", () => {
		expect(stripAnsi("\x1b[1m\x1b[31m\x1b[0m")).toBe("");
	});

	it("handles text that is only escape sequences", () => {
		expect(stripAnsi("\x1b[0m")).toBe("");
	});
});
