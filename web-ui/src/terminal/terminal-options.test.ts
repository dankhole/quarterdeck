// @vitest-environment node

import { describe, expect, it } from "vitest";

import { createQuarterdeckTerminalOptions } from "@/terminal/terminal-options";

describe("createQuarterdeckTerminalOptions", () => {
	it("enables richer terminal capability reporting", () => {
		const options = createQuarterdeckTerminalOptions({
			cursorColor: "#abcdef",
			fontWeight: 325,
			isMacPlatform: true,
			terminalBackgroundColor: "#101112",
		});

		expect(options.allowProposedApi).toBe(true);
		expect(options.cursorBlink).toBe(false);
		expect(options.cursorInactiveStyle).toBe("outline");
		expect(options.cursorStyle).toBe("block");
		// Fullscreen task launches must not remove normal-buffer shell/error output support.
		expect(options.scrollback).toBe(1_500);
		expect(options.scrollOnEraseInDisplay).toBe(true);
		expect(options.scrollOnUserInput).toBe(true);
		expect(options.convertEol).toBe(false);
		expect(options.disableStdin).toBe(false);
		expect(options.macOptionIsMeta).toBe(true);
		expect(options.windowOptions).toEqual({
			getCellSizePixels: true,
			getWinSizeChars: true,
			getWinSizePixels: true,
		});
		expect(options.theme?.background).toBe("#101112");
		expect(options.theme?.cursor).toBe("#abcdef");
	});
});
