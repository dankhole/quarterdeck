import {
	buildKey,
	type EnsurePersistentTerminalInput,
	PersistentTerminal,
	updateGlobalTerminalFontWeight,
	updateGlobalTerminalWebGLRenderer,
} from "@/terminal/persistent-terminal-manager";
import { createClientLogger } from "@/utils/client-logger";

const terminals = new Map<string, PersistentTerminal>();

export function ensurePersistentTerminal(input: EnsurePersistentTerminalInput): PersistentTerminal {
	const key = buildKey(input.workspaceId, input.taskId);
	let terminal = terminals.get(key);
	if (!terminal) {
		terminal = new PersistentTerminal(
			input.taskId,
			input.workspaceId,
			{ cursorColor: input.cursorColor, terminalBackgroundColor: input.terminalBackgroundColor },
			input.scrollOnEraseInDisplay,
			input.scrollback,
		);
		terminals.set(key, terminal);
		return terminal;
	}
	terminal.setAppearance({
		cursorColor: input.cursorColor,
		terminalBackgroundColor: input.terminalBackgroundColor,
	});
	if (input.scrollOnEraseInDisplay !== undefined) {
		terminal.setScrollOnEraseInDisplay(input.scrollOnEraseInDisplay);
	}
	return terminal;
}

export function disposePersistentTerminal(workspaceId: string, taskId: string): void {
	const key = buildKey(workspaceId, taskId);
	const terminal = terminals.get(key);
	if (!terminal) {
		return;
	}
	terminal.dispose();
	terminals.delete(key);
}

export function disposeAllPersistentTerminalsForWorkspace(workspaceId: string): void {
	for (const [key, terminal] of terminals.entries()) {
		if (!key.startsWith(`${workspaceId}:`)) {
			continue;
		}
		terminal.dispose();
		terminals.delete(key);
	}
}

export function writeToTerminalBuffer(workspaceId: string, taskId: string, text: string): void {
	const key = buildKey(workspaceId, taskId);
	const terminal = terminals.get(key);
	if (!terminal) {
		return;
	}
	terminal.writeText(text);
}

export function isTerminalSessionRunning(workspaceId: string, taskId: string): boolean {
	const key = buildKey(workspaceId, taskId);
	const terminal = terminals.get(key);
	if (!terminal) {
		return false;
	}
	return terminal.sessionState === "running";
}

export function resetAllTerminalRenderers(): number {
	const count = terminals.size;
	if (count === 0) {
		terminalDebugLog.warn("resetAllTerminalRenderers — no terminals in registry");
		return 0;
	}
	const t0 = performance.now();
	terminalDebugLog.info(`resetting renderers for ${count} terminal(s)`, {
		keys: [...terminals.keys()],
		dpr: window.devicePixelRatio,
	});
	for (const terminal of terminals.values()) {
		terminal.resetRenderer();
	}
	const elapsed = (performance.now() - t0).toFixed(1);
	terminalDebugLog.info(`renderer reset complete — ${elapsed}ms total`);
	return count;
}

export function restoreAllTerminals(): number {
	const count = terminals.size;
	if (count === 0) {
		terminalDebugLog.warn("restoreAllTerminals — no terminals in registry");
		return 0;
	}
	terminalDebugLog.info(`requesting restore for ${count} terminal(s)`, {
		keys: [...terminals.keys()],
	});
	for (const terminal of terminals.values()) {
		terminal.requestRestore();
	}
	return count;
}

export function setTerminalFontWeight(weight: number): void {
	updateGlobalTerminalFontWeight(weight);
	for (const terminal of terminals.values()) {
		terminal.setFontWeight(weight);
	}
}

export function setTerminalWebGLRenderer(enabled: boolean): void {
	updateGlobalTerminalWebGLRenderer(enabled);
	for (const terminal of terminals.values()) {
		terminal.setWebGLRenderer(enabled);
	}
}

const terminalDebugLog = createClientLogger("terminal");

export function dumpTerminalDebugInfo(): void {
	if (terminals.size === 0) {
		terminalDebugLog.info("No active terminals");
		return;
	}
	for (const [key, pt] of terminals.entries()) {
		const info = pt.getBufferDebugInfo();
		const taskId = key.split(":").slice(1).join(":");
		terminalDebugLog.info(`${taskId}`, {
			buffer: info.activeBuffer,
			scrollback: `${info.normalScrollbackLines} lines (max ${info.scrollbackOption})`,
			normal: `len=${info.normalLength} baseY=${info.normalBaseY}`,
			alternate: `len=${info.alternateLength}`,
			viewport: info.viewportRows,
			scrollOnEraseInDisplay: info.scrollOnEraseInDisplay,
			session: info.sessionState,
		});
	}
}
