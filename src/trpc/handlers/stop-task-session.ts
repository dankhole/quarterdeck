import { parseTaskSessionStopRequest } from "../../core";
import type { TerminalSessionManager } from "../../terminal";
import type { RuntimeTrpcProjectScope } from "../app-router-context";

export interface StopTaskSessionDeps {
	getScopedTerminalManager: (scope: RuntimeTrpcProjectScope) => Promise<TerminalSessionManager>;
}

export async function handleStopTaskSession(
	projectScope: RuntimeTrpcProjectScope,
	input: unknown,
	deps: StopTaskSessionDeps,
) {
	try {
		const body = parseTaskSessionStopRequest(input);
		const terminalManager = await deps.getScopedTerminalManager(projectScope);
		const summary = body.waitForExit
			? await terminalManager.stopTaskSessionAndWaitForExit(body.taskId)
			: terminalManager.stopTaskSession(body.taskId);
		return {
			ok: Boolean(summary),
			summary,
		};
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		return {
			ok: false,
			summary: null,
			error: message,
		};
	}
}
