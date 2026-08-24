import type { RuntimeTaskSessionSummary } from "../core";
import type { TerminalRestoreSnapshot } from "./terminal-state-mirror";

export interface TerminalSessionListener {
	onOutput?: (chunk: Buffer) => void;
	onState?: (summary: RuntimeTaskSessionSummary) => void;
	onExit?: (code: number | null) => void;
}

export interface TerminalSessionInputOptions {
	explicitUserSubmission?: boolean;
}

export interface TerminalSessionService {
	attach(taskId: string, listener: TerminalSessionListener): (() => void) | null;
	getRestoreSnapshot(taskId: string): Promise<TerminalRestoreSnapshot | null>;
	recoverStaleSession(taskId: string): RuntimeTaskSessionSummary | null;
	writeInput(taskId: string, data: Buffer, options?: TerminalSessionInputOptions): RuntimeTaskSessionSummary | null;
	resize(
		taskId: string,
		cols: number,
		rows: number,
		pixelWidth?: number,
		pixelHeight?: number,
		force?: boolean,
	): boolean;
	pauseOutput(taskId: string): boolean;
	resumeOutput(taskId: string): boolean;
	stopTaskSession(taskId: string): RuntimeTaskSessionSummary | null;
}
