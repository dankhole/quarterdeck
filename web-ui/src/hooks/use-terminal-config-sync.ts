import { useEffect } from "react";
import { setTerminalFontWeight, setTerminalWebGLRenderer } from "@/terminal/terminal-registry";

interface UseTerminalConfigSyncInput {
	terminalFontWeight: number;
	terminalWebGLRenderer: boolean;
}

/**
 * Syncs runtime config terminal settings (font weight, WebGL renderer) to
 * the persistent terminal manager so they take effect on existing terminals.
 */
export function useTerminalConfigSync({ terminalFontWeight, terminalWebGLRenderer }: UseTerminalConfigSyncInput): void {
	useEffect(() => {
		setTerminalFontWeight(terminalFontWeight);
	}, [terminalFontWeight]);

	useEffect(() => {
		setTerminalWebGLRenderer(terminalWebGLRenderer);
	}, [terminalWebGLRenderer]);
}
