import type { TaskResourceOperationRunner } from "../core";
import type { NativeInputAuthorization } from "../state/native-input-authorization";
import type { ProjectBoardCommandScope } from "../state/project-board-command-service";
import type { TerminalSessionManager } from "../terminal/session-manager";
import type { TerminalInputWriter } from "../terminal/terminal-session-service";

interface NativeTerminalInputDependencies {
	scope: ProjectBoardCommandScope;
	taskId: string;
	manager: Pick<TerminalSessionManager, "getTaskSessionProcessIdentity" | "writeInput">;
	authorization: NativeInputAuthorization;
	taskResourceOperations: TaskResourceOperationRunner;
	hasStructuredOwner: () => boolean;
}

/** A connection may write only to the exact native PTY it attached to. */
export function createNativeTerminalInputWriter({
	scope,
	taskId,
	manager,
	authorization,
	taskResourceOperations,
	hasStructuredOwner,
}: NativeTerminalInputDependencies): TerminalInputWriter {
	let sessionInstanceId = manager.getTaskSessionProcessIdentity(taskId)?.sessionInstanceId;
	let disposed = false;
	const isCurrentSession = () =>
		!disposed &&
		sessionInstanceId !== undefined &&
		manager.getTaskSessionProcessIdentity(taskId)?.sessionInstanceId === sessionInstanceId;

	return {
		write: async (data) => {
			// A socket may attach before launch. Bind only when input arrives to
			// an existing PTY, before enqueueing; never carry pre-launch bytes forward.
			if (!disposed && sessionInstanceId === undefined) {
				sessionInstanceId = manager.getTaskSessionProcessIdentity(taskId)?.sessionInstanceId;
			}
			if (!isCurrentSession()) return null;
			return await taskResourceOperations.run(scope.projectId, taskId, async () => {
				if (!isCurrentSession()) return null;
				for (;;) {
					const ownership = await authorization.read();
					if (!isCurrentSession()) return null;
					// Observation can complete outside the task coordinator. Recheck the
					// subscription after the await, then authorize and write synchronously.
					if (!authorization.isCurrent(ownership)) continue;
					if ((ownership && ownership.state !== "native_tui") || hasStructuredOwner()) {
						throw new Error("Task is owned by the structured execution runner.");
					}
					return manager.writeInput(taskId, data);
				}
			});
		},
		dispose: () => {
			disposed = true;
			authorization.dispose();
		},
	};
}
