import type { Terminal } from "@xterm/xterm";

import type { RuntimeTerminalWsClientMessage } from "@/runtime/types";

interface SlotWriteQueueCallbacks {
	sendControlMessage: (msg: RuntimeTerminalWsClientMessage) => boolean;
	notifyOutputText: (text: string) => void;
	isDisposed: () => boolean;
}

export class SlotWriteQueue {
	private queue: Promise<void> = Promise.resolve();

	constructor(
		private readonly terminal: Terminal,
		private readonly callbacks: SlotWriteQueueCallbacks,
	) {}

	enqueue(
		data: string | Uint8Array,
		options: {
			ackBytes?: number;
			notifyText?: string | null;
		} = {},
	): Promise<void> {
		const ackBytes = options.ackBytes ?? 0;
		const notifyText = options.notifyText ?? null;
		this.queue = this.queue
			.catch(() => undefined)
			.then(
				async () =>
					await new Promise<void>((resolve) => {
						if (this.callbacks.isDisposed()) {
							resolve();
							return;
						}
						this.terminal.write(data, () => {
							if (notifyText) {
								this.callbacks.notifyOutputText(notifyText);
							}
							if (ackBytes > 0) {
								this.callbacks.sendControlMessage({
									type: "output_ack",
									bytes: ackBytes,
								});
							}
							resolve();
						});
					}),
			);
		return this.queue;
	}

	drain(): Promise<void> {
		return this.queue.catch(() => undefined);
	}

	chainAction(action: (terminal: Terminal) => void, isDisposed: () => boolean): void {
		this.queue = this.queue
			.catch(() => undefined)
			.then(() => {
				if (!isDisposed()) {
					action(this.terminal);
				}
			});
	}
}
