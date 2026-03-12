import { Colors } from "@blueprintjs/core";
import type { ITerminalOptions } from "@xterm/xterm";

interface CreateKanbanTerminalOptionsInput {
	cursorColor: string;
	isMacPlatform: boolean;
	terminalBackgroundColor: string;
}

const TERMINAL_WORD_SEPARATOR = " ()[]{}',\"`";
const TERMINAL_FONT_FAMILY =
	"'Cascadia Code', 'Fira Code', 'JetBrains Mono', 'SF Mono', Menlo, Monaco, 'Courier New', monospace";

export function createKanbanTerminalOptions({
	cursorColor,
	isMacPlatform,
	terminalBackgroundColor,
}: CreateKanbanTerminalOptionsInput): ITerminalOptions {
	return {
		allowProposedApi: true,
		allowTransparency: false,
		convertEol: false,
		cursorBlink: true,
		cursorStyle: "bar",
		cursorWidth: 1,
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
			foreground: Colors.LIGHT_GRAY5,
			selectionBackground: `${Colors.BLUE3}4D`,
			selectionForeground: Colors.WHITE,
			selectionInactiveBackground: `${Colors.DARK_GRAY3}66`,
		},
		windowOptions: {
			getCellSizePixels: true,
			getWinSizeChars: true,
			getWinSizePixels: true,
		},
		wordSeparator: TERMINAL_WORD_SEPARATOR,
	};
}
