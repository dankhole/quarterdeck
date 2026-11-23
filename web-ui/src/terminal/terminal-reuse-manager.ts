import type { TerminalPasteOptions } from "@/terminal/terminal-input";
import { acquireForTask, attachPoolContainer, cancelWarmup, releaseTask, warmup } from "@/terminal/terminal-pool";
import type { PersistentTerminalSubscriber } from "@/terminal/terminal-session-handle";

export type TaskTerminalSubscriber = PersistentTerminalSubscriber;

export interface TaskTerminalHandle {
	subscribe: (subscriber: TaskTerminalSubscriber) => () => void;
	attachToStageContainer: (container: HTMLDivElement) => void;
	show: (
		appearance: {
			cursorColor: string;
			terminalBackgroundColor: string;
		},
		options: {
			autoFocus?: boolean;
			isVisible?: boolean;
		},
	) => void;
	hide: () => void;
	park: () => void;
	reset: () => void;
	requestRestore: () => void;
	input: (text: string) => boolean;
	paste: (text: string, options?: TerminalPasteOptions) => boolean;
	waitForLikelyPrompt: (timeoutMs: number) => Promise<boolean>;
	clear: () => void;
	stop: () => Promise<void>;
	focus: () => void;
}

export function stageTaskTerminalContainer(container: HTMLDivElement): void {
	attachPoolContainer(container);
}

export function acquireTaskTerminal(taskId: string, projectId: string): TaskTerminalHandle {
	return acquireForTask(taskId, projectId);
}

export function releaseTaskTerminal(taskId: string): void {
	releaseTask(taskId);
}

export function requestTaskTerminalPrewarm(taskId: string, projectId: string): void {
	warmup(taskId, projectId);
}

export function cancelTaskTerminalPrewarmRequest(taskId: string): void {
	cancelWarmup(taskId);
}
