import type { RuntimeTaskSessionSummary } from "@/runtime/types";
import { acquireForTask, attachPoolContainer, cancelWarmup, releaseTask, warmup } from "@/terminal/terminal-pool";

export interface TaskTerminalSubscriber {
	onConnectionReady?: (taskId: string) => void;
	onLastError?: (message: string | null) => void;
	onSummary?: (summary: RuntimeTaskSessionSummary) => void;
	onOutputText?: (text: string) => void;
	onExit?: (taskId: string, exitCode: number | null) => void;
}

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
	input: (text: string) => boolean;
	paste: (text: string) => boolean;
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
