import { parseShellSessionStartRequest } from "../../core";
import type { TerminalSessionManager } from "../../terminal";
import { resolveTaskWorkingDirectory } from "../../workdir";
import type { RuntimeTrpcProjectScope } from "../app-router-context";

export interface StartShellSessionDeps {
	getScopedTerminalManager: (scope: RuntimeTrpcProjectScope) => Promise<TerminalSessionManager>;
	resolveInteractiveShellCommand: () => { binary: string; args: string[] };
}

export async function handleStartShellSession(
	projectScope: RuntimeTrpcProjectScope,
	input: unknown,
	deps: StartShellSessionDeps,
) {
	try {
		const body = parseShellSessionStartRequest(input);
		const terminalManager = await deps.getScopedTerminalManager(projectScope);
		const shell = deps.resolveInteractiveShellCommand();
		let shellCwd = projectScope.projectPath;
		if (body.projectTaskId) {
			shellCwd = await resolveTaskWorkingDirectory({
				projectPath: projectScope.projectPath,
				taskId: body.projectTaskId,
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
