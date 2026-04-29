import {
	forEachDedicatedTerminal,
	getDedicatedTerminal,
	getDedicatedTerminalCount,
} from "@/terminal/terminal-dedicated-registry";
import { type TerminalSlot, updateGlobalTerminalFontWeight } from "@/terminal/terminal-slot";

interface TerminalSurfaceLogger {
	info: (message: string, metadata?: unknown) => void;
	warn: (message: string, metadata?: unknown) => void;
}

export interface TerminalSurfaceProvider {
	getPoolSlots: () => readonly TerminalSlot[];
	getPooledSlotForTask: (taskId: string) => TerminalSlot | null;
	log: TerminalSurfaceLogger;
}

/** Iterate over all terminal slots (pool + dedicated). */
function* allTerminalSlots(provider: TerminalSurfaceProvider): Generator<TerminalSlot> {
	for (const slot of provider.getPoolSlots()) {
		yield slot;
	}
	const dedicatedSlots: TerminalSlot[] = [];
	forEachDedicatedTerminal((slot) => {
		dedicatedSlots.push(slot);
	});
	yield* dedicatedSlots;
}

/**
 * Reset the renderer on all terminals (pool + dedicated).
 */
export function resetAllTerminalRenderers(provider: TerminalSurfaceProvider): void {
	const count = provider.getPoolSlots().length + getDedicatedTerminalCount();
	if (count === 0) {
		provider.log.warn("resetAllTerminalRenderers — no terminals");
		return;
	}
	const t0 = performance.now();
	provider.log.info(`resetting renderers for ${count} terminal(s)`);
	for (const slot of allTerminalSlots(provider)) {
		slot.resetRenderer();
	}
	const elapsed = (performance.now() - t0).toFixed(1);
	provider.log.info(`renderer reset complete — ${elapsed}ms total`);
}

/**
 * Set font weight on all terminals (pool + dedicated).
 */
export function setTerminalFontWeight(provider: TerminalSurfaceProvider, weight: number): void {
	updateGlobalTerminalFontWeight(weight);
	for (const slot of allTerminalSlots(provider)) {
		slot.setFontWeight(weight);
	}
}

/**
 * Write text to a terminal buffer. Checks pool first, then dedicated terminals.
 */
export function writeToTerminalBuffer(
	provider: TerminalSurfaceProvider,
	projectId: string,
	taskId: string,
	text: string,
): void {
	const poolSlot = provider.getPooledSlotForTask(taskId);
	if (poolSlot) {
		poolSlot.writeText(text);
		return;
	}
	const dedicated = getDedicatedTerminal(projectId, taskId);
	if (dedicated) {
		dedicated.writeText(text);
	}
}

/**
 * Check if a terminal session is running. Checks pool first, then dedicated.
 */
export function isTerminalSessionRunning(
	provider: TerminalSurfaceProvider,
	projectId: string,
	taskId: string,
): boolean {
	const poolSlot = provider.getPooledSlotForTask(taskId);
	if (poolSlot) {
		return poolSlot.sessionState === "running";
	}
	const dedicated = getDedicatedTerminal(projectId, taskId);
	if (dedicated) {
		return dedicated.sessionState === "running";
	}
	return false;
}
