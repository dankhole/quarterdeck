import { useEffect } from "react";
import { setTerminalFontWeight } from "@/terminal/terminal-pool";

interface UseTerminalConfigSyncInput {
	terminalFontWeight: number;
}

/**
 * Syncs runtime config terminal settings (font weight) to
 * the persistent terminal manager so they take effect on existing terminals.
 */
export function useTerminalConfigSync({ terminalFontWeight }: UseTerminalConfigSyncInput): void {
	useEffect(() => {
		setTerminalFontWeight(terminalFontWeight);
	}, [terminalFontWeight]);
}
