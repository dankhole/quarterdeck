import type { TerminalSessionService } from "./terminal-session-service";
import type { TerminalWsRestoreCoordinator } from "./terminal-ws-restore-coordinator";
import type { TerminalStreamState } from "./terminal-ws-types";

interface EnsureOutputListenerRequest {
	streamState: TerminalStreamState;
	taskId: string;
	terminalManager: TerminalSessionService;
	restoreCoordinator: TerminalWsRestoreCoordinator;
}

export function ensureTerminalWsOutputListener({
	streamState,
	taskId,
	terminalManager,
	restoreCoordinator,
}: EnsureOutputListenerRequest): void {
	if (streamState.detachOutputListener) {
		return;
	}
	streamState.detachOutputListener = terminalManager.attach(taskId, {
		onOutput: (chunk) => {
			for (const viewerState of streamState.viewers.values()) {
				restoreCoordinator.handleLiveOutput(viewerState, chunk);
			}
		},
	});
}
