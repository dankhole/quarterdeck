import { DETAIL_TERMINAL_TASK_PREFIX, HOME_TERMINAL_TASK_ID } from "@/terminal/terminal-constants";
import type { PersistentTerminalAppearance, TerminalSlot } from "@/terminal/terminal-slot";
import { createClientLogger } from "@/utils/client-logger";

const log = createClientLogger("terminal-dedicated-registry");

export interface EnsureDedicatedTerminalInput extends PersistentTerminalAppearance {
	taskId: string;
	projectId: string;
}

const dedicatedTerminals = new Map<string, TerminalSlot>(); // projectId:taskId -> TerminalSlot

function buildDedicatedTerminalKey(projectId: string, taskId: string): string {
	return `${projectId}:${taskId}`;
}

export function isDedicatedTerminalTaskId(taskId: string): boolean {
	return taskId === HOME_TERMINAL_TASK_ID || taskId.startsWith(DETAIL_TERMINAL_TASK_PREFIX);
}

export function getDedicatedTerminal(projectId: string, taskId: string): TerminalSlot | null {
	return dedicatedTerminals.get(buildDedicatedTerminalKey(projectId, taskId)) ?? null;
}

export function ensureDedicatedTerminal(
	input: EnsureDedicatedTerminalInput,
	createSlot: (appearance: PersistentTerminalAppearance) => TerminalSlot,
): TerminalSlot {
	const key = buildDedicatedTerminalKey(input.projectId, input.taskId);
	const existing = dedicatedTerminals.get(key);
	if (existing) {
		existing.setAppearance({
			cursorColor: input.cursorColor,
			terminalBackgroundColor: input.terminalBackgroundColor,
		});
		existing.ensureConnected();
		return existing;
	}

	const slot = createSlot({
		cursorColor: input.cursorColor,
		terminalBackgroundColor: input.terminalBackgroundColor,
	});
	slot.connectToTask(input.taskId, input.projectId);
	dedicatedTerminals.set(key, slot);
	log.debug(`ensureDedicatedTerminal — created slot ${slot.slotId} for ${key}`);
	return slot;
}

export function disposeDedicatedTerminal(projectId: string, taskId: string): void {
	const key = buildDedicatedTerminalKey(projectId, taskId);
	const slot = dedicatedTerminals.get(key);
	if (!slot) {
		return;
	}
	slot.dispose();
	dedicatedTerminals.delete(key);
	log.debug(`disposeDedicatedTerminal — disposed ${key}`);
}

export function disposeAllDedicatedTerminalsForProject(projectId: string): void {
	const prefix = `${projectId}:`;
	for (const [key, slot] of dedicatedTerminals.entries()) {
		if (!key.startsWith(prefix)) {
			continue;
		}
		slot.dispose();
		dedicatedTerminals.delete(key);
		log.debug(`disposeAllDedicatedTerminalsForProject — disposed ${key}`);
	}
}

export function forEachDedicatedTerminal(callback: (slot: TerminalSlot, key: string) => void): void {
	for (const [key, slot] of dedicatedTerminals.entries()) {
		callback(slot, key);
	}
}

export function getDedicatedTerminalCount(): number {
	return dedicatedTerminals.size;
}

/** @internal — test only. Clears the dedicated registry between runs. */
export function _disposeAllDedicatedTerminalsForTesting(): void {
	for (const slot of dedicatedTerminals.values()) {
		slot.dispose();
	}
	dedicatedTerminals.clear();
}
