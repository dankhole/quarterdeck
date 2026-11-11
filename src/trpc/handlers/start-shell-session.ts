import {
	getRuntimeDetailTerminalTaskId,
	getTaskColumnId,
	parseShellSessionStartRequest,
	RUNTIME_HOME_TERMINAL_TASK_ID,
	type TaskResourceOperationRunner,
} from "../../core";
import { loadProjectState } from "../../state/project-state";
import type { TerminalSessionManager } from "../../terminal";
import { resolveTaskWorkingDirectory } from "../../workdir";
import type { RuntimeTrpcProjectScope } from "../app-router-context";

export interface StartShellSessionDeps {
	getScopedTerminalManager: (scope: RuntimeTrpcProjectScope) => Promise<TerminalSessionManager>;
	resolveInteractiveShellCommand: () => { binary: string; args: string[] };
	taskResourceOperations: TaskResourceOperationRunner;
}

export async function handleStartShellSession(
	projectScope: RuntimeTrpcProjectScope,
	input: unknown,
	deps: StartShellSessionDeps,
) {
	try {
		const body = parseShellSessionStartRequest(input);
		const expectedTaskId = body.projectTaskId
			? getRuntimeDetailTerminalTaskId(body.projectTaskId)
			: RUNTIME_HOME_TERMINAL_TASK_ID;
		if (body.taskId !== expectedTaskId) {
			throw new Error("Shell session identity does not match its workspace.");
		}
		const startShell = async () => {
			if (body.projectTaskId) {
				const state = await loadProjectState(projectScope.projectPath);
				const columnId = getTaskColumnId(state.board, body.projectTaskId);
				if (!columnId) throw new Error("The task no longer exists.");
				if (columnId === "trash") {
					throw new Error("Restore the task from Trash before starting its shell.");
				}
			}
			const terminalManager = await deps.getScopedTerminalManager(projectScope);
			const shell = deps.resolveInteractiveShellCommand();
			let shellCwd = projectScope.projectPath;
			if (body.projectTaskId) {
				shellCwd = await resolveTaskWorkingDirectory({
					projectPath: projectScope.projectPath,
					taskId: body.projectTaskId,
					baseRef: body.baseRef,
					ensure: body.expectedExitedSessionInstanceId === undefined,
				});
			}
			const previousSummary = terminalManager.store.getSummary(body.taskId);
			const summary = await terminalManager.startShellSession({
				taskId: body.taskId,
				expectedExitedSessionInstanceId: body.expectedExitedSessionInstanceId,
				cwd: shellCwd,
				cols: body.cols,
				rows: body.rows,
				binary: shell.binary,
				args: shell.args,
			});
			const hadExistingSession = Boolean(
				previousSummary?.agentId === null &&
					previousSummary.state === "running" &&
					previousSummary.pid !== null &&
					typeof previousSummary.sessionInstanceId === "string" &&
					previousSummary.sessionInstanceId.length > 0 &&
					previousSummary.sessionInstanceId === summary.sessionInstanceId &&
					previousSummary.pid === summary.pid &&
					summary.state === "running",
			);
			return { ok: true, summary, shellBinary: shell.binary, hadExistingSession };
		};
		return await deps.taskResourceOperations.run(
			projectScope.projectId,
			body.projectTaskId ?? body.taskId,
			startShell,
		);
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		return {
			ok: false,
			hadExistingSession: false,
			summary: null,
			shellBinary: null,
			error: message,
		};
	}
}
