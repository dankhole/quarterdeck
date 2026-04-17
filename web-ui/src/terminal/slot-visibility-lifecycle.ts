import { createClientLogger } from "@/utils/client-logger";

const log = createClientLogger("slot-visibility-lifecycle");

interface SlotVisibilityLifecycleCallbacks {
	getTaskId: () => string | null;
	getWorkspaceId: () => string | null;
	hasVisibleContainer: () => boolean;
	hasIoSocket: () => boolean;
	hasControlSocket: () => boolean;
	refreshTerminal: () => void;
	reconnectSockets: (taskId: string, projectId: string) => void;
	isDisposed: () => boolean;
}

export class SlotVisibilityLifecycle {
	private readonly visibilityChangeHandler: () => void;

	constructor(
		private readonly slotId: number,
		private readonly callbacks: SlotVisibilityLifecycleCallbacks,
	) {
		this.visibilityChangeHandler = () => {
			if (
				document.visibilityState !== "visible" ||
				!this.callbacks.hasVisibleContainer() ||
				this.callbacks.isDisposed()
			) {
				return;
			}

			const taskId = this.callbacks.getTaskId();
			log.debug(`slot ${this.slotId} tab-return refresh`, { task: taskId });
			this.callbacks.refreshTerminal();

			const projectId = this.callbacks.getWorkspaceId();
			const hasDeadSocket = !this.callbacks.hasIoSocket() || !this.callbacks.hasControlSocket();
			if (taskId && projectId && hasDeadSocket) {
				log.info(`slot ${this.slotId} tab-return reconnecting dead sockets`, { task: taskId });
				this.callbacks.reconnectSockets(taskId, projectId);
			}
		};

		document.addEventListener("visibilitychange", this.visibilityChangeHandler);
	}

	dispose(): void {
		document.removeEventListener("visibilitychange", this.visibilityChangeHandler);
	}
}
