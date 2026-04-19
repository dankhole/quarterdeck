import { cancelTaskTerminalPrewarmRequest, requestTaskTerminalPrewarm } from "@/terminal/terminal-reuse-manager";

export interface TerminalPrewarmPolicy {
	cancelTaskHoverPrewarm: (taskId: string) => void;
	requestTaskHoverPrewarm: (taskId: string, projectId: string) => void;
}

class EnabledTerminalPrewarmPolicy implements TerminalPrewarmPolicy {
	requestTaskHoverPrewarm(taskId: string, projectId: string): void {
		requestTaskTerminalPrewarm(taskId, projectId);
	}

	cancelTaskHoverPrewarm(taskId: string): void {
		cancelTaskTerminalPrewarmRequest(taskId);
	}
}

class DisabledTerminalPrewarmPolicy implements TerminalPrewarmPolicy {
	requestTaskHoverPrewarm(): void {}

	cancelTaskHoverPrewarm(): void {}
}

const enabledTerminalPrewarmPolicy = new EnabledTerminalPrewarmPolicy();
const disabledTerminalPrewarmPolicy = new DisabledTerminalPrewarmPolicy();
let currentTerminalPrewarmPolicy: TerminalPrewarmPolicy = enabledTerminalPrewarmPolicy;

export function getTerminalPrewarmPolicy(): TerminalPrewarmPolicy {
	return currentTerminalPrewarmPolicy;
}

export function createDisabledTerminalPrewarmPolicy(): TerminalPrewarmPolicy {
	return disabledTerminalPrewarmPolicy;
}

export function setTerminalPrewarmPolicyForTesting(policy: TerminalPrewarmPolicy | null): void {
	currentTerminalPrewarmPolicy = policy ?? enabledTerminalPrewarmPolicy;
}
