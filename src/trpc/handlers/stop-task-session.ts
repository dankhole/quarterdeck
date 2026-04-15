import { parseTaskSessionStopRequest } from "../../core/api-validation";
import type { TerminalSessionManager } from "../../terminal/session-manager";
import type { RuntimeTrpcWorkspaceScope } from "../app-router-context";

export interface StopTaskSessionDeps {
	getScopedTerminalManager: (scope: RuntimeTrpcWorkspaceScope) => Promise<TerminalSessionManager>;
}

export async function handleStopTaskSession(
	workspaceScope: RuntimeTrpcWorkspaceScope,
	input: unknown,
	deps: StopTaskSessionDeps,
) {
	try {
		const body = parseTaskSessionStopRequest(input);
		const terminalManager = await deps.getScopedTerminalManager(workspaceScope);
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
