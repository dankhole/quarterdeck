import type { ITerminalOptions } from "@xterm/xterm";

import { TERMINAL_THEME_COLORS } from "@/terminal/theme-colors";

interface CreateQuarterdeckTerminalOptionsInput {
	cursorColor: string;
	isMacPlatform: boolean;
	terminalBackgroundColor: string;
}

const TERMINAL_WORD_SEPARATOR = " ()[]{}',\"`";
export const TERMINAL_FONT_SIZE = 13;
export const TERMINAL_PRIMARY_FONT = "JetBrainsMono Nerd Font Mono";
const TERMINAL_FONT_FAMILY = `'${TERMINAL_PRIMARY_FONT}', 'JetBrainsMono Nerd Font', 'Cascadia Code', 'Fira Code', 'JetBrains Mono', 'SF Mono', Menlo, Monaco, 'Courier New', monospace`;

export function createQuarterdeckTerminalOptions({
	cursorColor,
	isMacPlatform,
	terminalBackgroundColor,
}: CreateQuarterdeckTerminalOptionsInput): ITerminalOptions {
	return {
		allowProposedApi: true,
		allowTransparency: false,
		convertEol: false,
		cursorBlink: false,
		cursorInactiveStyle: "outline",
		cursorStyle: "block",
		disableStdin: false,
		fontFamily: TERMINAL_FONT_FAMILY,
		fontSize: 13,
		fontWeight: "normal",
		fontWeightBold: "bold",
		letterSpacing: 0,
		lineHeight: 1,
		macOptionClickForcesSelection: isMacPlatform,
		macOptionIsMeta: isMacPlatform,
		rightClickSelectsWord: false,
		scrollOnEraseInDisplay: true,
		scrollOnUserInput: true,
		scrollback: 10_000,
		smoothScrollDuration: 0,
		theme: {
			background: terminalBackgroundColor,
			cursor: cursorColor,
			cursorAccent: terminalBackgroundColor,
			foreground: TERMINAL_THEME_COLORS.textPrimary,
			selectionBackground: TERMINAL_THEME_COLORS.selectionBackground,
			selectionForeground: TERMINAL_THEME_COLORS.selectionForeground,
			selectionInactiveBackground: TERMINAL_THEME_COLORS.selectionInactiveBackground,
		},
		windowOptions: {
			getCellSizePixels: true,
			getWinSizeChars: true,
			getWinSizePixels: true,
		},
		wordSeparator: TERMINAL_WORD_SEPARATOR,
	};
}
