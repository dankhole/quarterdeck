import { EventEmitter } from "node:events";

import { WebSocket } from "ws";

import type { RuntimeStateStreamMessage } from "../../src/core";

export interface RuntimeStreamClient {
	socket: WebSocket;
	waitForMessage: (
		predicate: (message: RuntimeStateStreamMessage) => boolean,
		timeoutMs?: number,
	) => Promise<RuntimeStateStreamMessage>;
	collectFor: (durationMs: number) => Promise<RuntimeStateStreamMessage[]>;
	close: () => Promise<void>;
}

export async function connectRuntimeStream(url: string): Promise<RuntimeStreamClient> {
	const socket = new WebSocket(url);
	const emitter = new EventEmitter();
	const queue: RuntimeStateStreamMessage[] = [];

	socket.on("message", (raw) => {
		try {
			const parsed = JSON.parse(String(raw)) as RuntimeStateStreamMessage;
			queue.push(parsed);
			emitter.emit("message");
		} catch {
			// Ignore malformed messages in tests.
		}
	});

	await new Promise<void>((resolveOpen, rejectOpen) => {
		const timeoutId = setTimeout(() => {
			rejectOpen(new Error(`Timed out connecting websocket: ${url}`));
		}, 5_000);
		socket.once("open", () => {
			clearTimeout(timeoutId);
			resolveOpen();
		});
		socket.once("error", (error) => {
			clearTimeout(timeoutId);
			rejectOpen(error);
		});
	});

	const waitForMessage = async (
		predicate: (message: RuntimeStateStreamMessage) => boolean,
		timeoutMs = 5_000,
	): Promise<RuntimeStateStreamMessage> =>
		await new Promise((resolveMessage, rejectMessage) => {
			let settled = false;
			const tryResolve = () => {
				if (settled) {
					return;
				}
				const index = queue.findIndex(predicate);
				if (index < 0) {
					return;
				}
				const [message] = queue.splice(index, 1);
				if (!message) {
					return;
				}
				settled = true;
				clearTimeout(timeoutId);
				emitter.removeListener("message", tryResolve);
				resolveMessage(message);
			};
			const timeoutId = setTimeout(() => {
				if (settled) {
					return;
				}
				settled = true;
				emitter.removeListener("message", tryResolve);
				const queuedMessages = queue.slice(-20).map((message) => {
					if (message.type === "project_state_updated") {
						const counts = Object.fromEntries(
							message.projectState.board.columns.map((column) => [column.id, column.cards.length]),
						);
						return `${message.type}(revision=${message.projectState.revision},counts=${JSON.stringify(counts)})`;
					}
					if (message.type === "projects_updated") {
						return `${message.type}(${message.projects
							.map(
								(project) =>
									`${project.id}:revision=${project.boardRevision},counts=${JSON.stringify(project.taskCounts)}`,
							)
							.join(";")})`;
					}
					if (message.type === "task_notification" || message.type === "task_sessions_updated") {
						return `${message.type}(${message.summaries
							.map(
								(summary) =>
									`${summary.taskId}:${summary.state}/${summary.reviewReason ?? "none"}/${summary.outstandingInteraction?.status ?? "none"}`,
							)
							.join(";")})`;
					}
					return message.type;
				});
				rejectMessage(
					new Error(
						`Timed out waiting for expected websocket message. Queued messages: ${queuedMessages.join(", ") || "none"}.`,
					),
				);
			}, timeoutMs);
			emitter.on("message", tryResolve);
			tryResolve();
		});

	return {
		socket,
		waitForMessage,
		collectFor: async (durationMs: number) => {
			await new Promise((resolveDelay) => {
				setTimeout(resolveDelay, durationMs);
			});
			const messages = queue.slice();
			queue.length = 0;
			return messages;
		},
		close: async () => {
			if (socket.readyState === WebSocket.CLOSED || socket.readyState === WebSocket.CLOSING) {
				return;
			}
			await new Promise<void>((resolveClose) => {
				socket.once("close", () => resolveClose());
				socket.close();
			});
		},
	};
}
