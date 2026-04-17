import { parseShellSessionStartRequest } from "../../core";
import type { TerminalSessionManager } from "../../terminal";
import { resolveTaskWorkingDirectory } from "../../workspace";
import type { RuntimeTrpcWorkspaceScope } from "../app-router-context";

export interface StartShellSessionDeps {
	getScopedTerminalManager: (scope: RuntimeTrpcWorkspaceScope) => Promise<TerminalSessionManager>;
	resolveInteractiveShellCommand: () => { binary: string; args: string[] };
}

export async function handleStartShellSession(
	workspaceScope: RuntimeTrpcWorkspaceScope,
	input: unknown,
	deps: StartShellSessionDeps,
) {
	try {
		const body = parseShellSessionStartRequest(input);
		const terminalManager = await deps.getScopedTerminalManager(workspaceScope);
		const shell = deps.resolveInteractiveShellCommand();
		let shellCwd = workspaceScope.workspacePath;
		if (body.workspaceTaskId) {
			shellCwd = await resolveTaskWorkingDirectory({
				workspacePath: workspaceScope.workspacePath,
				taskId: body.workspaceTaskId,
				baseRef: body.baseRef,
				ensure: true,
			});
		}
		const summary = await terminalManager.startShellSession({
			taskId: body.taskId,
			cwd: shellCwd,
			cols: body.cols,
			rows: body.rows,
			binary: shell.binary,
			args: shell.args,
		});
		return {
			ok: true,
			summary,
			shellBinary: shell.binary,
		};
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		return {
			ok: false,
			summary: null,
			shellBinary: null,
			error: message,
		};
	}
}
