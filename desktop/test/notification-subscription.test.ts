import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WebSocket } from "ws";
import { QUARTERDECK_RUNTIME_PROTOCOL_VERSION } from "../../src/core/api/runtime-protocol.js";
import { createTestTaskSessionSummary } from "../../test/utilities/task-session-factory.js";
import { DesktopNotificationSubscription } from "../src/notification-subscription.js";
import type { SelectedRuntime } from "../src/runtime-selection.js";
import { DESKTOP_TOKEN_HEADER } from "../src/security-policy.js";

const generation = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const firstEpoch = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const secondEpoch = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const running = createTestTaskSessionSummary({
	taskId: "task",
	state: "running",
	pid: 123,
	sessionInstanceId: "launch",
	startedAt: 1,
});
const review = {
	...running,
	state: "awaiting_review" as const,
	reviewReason: "hook" as const,
	updatedAt: 2,
	lastHookAt: 2,
};
class FakeSocket extends EventEmitter {
	readyState: number = WebSocket.OPEN;
	send = vi.fn();
	close = vi.fn(() => {
		this.readyState = WebSocket.CLOSED;
		this.emit("close");
	});
	message(value: unknown): void {
		this.emit("message", Buffer.from(JSON.stringify(value)));
	}
}
const settings = {
	enabled: true,
	volume: 0.5,
	events: { permission: true, review: true, failure: true },
	onlyWhenHidden: false,
	suppressCurrentProject: { permission: false, review: false, failure: false },
};
const state = (owner: "desktop" | "browser", epoch: string | null) => ({ owner, epoch, runtimeGeneration: generation });
function baseline(socket: FakeSocket, summary = running) {
	socket.message({
		type: "snapshot",
		runtimeProtocolVersion: QUARTERDECK_RUNTIME_PROTOCOL_VERSION,
		currentProjectId: null,
		projects: [
			{
				id: "project",
				name: "Synthetic project",
				path: "/synthetic",
				metadataRevision: 1,
				boardRevision: 1,
				taskCounts: { in_progress: 1, review: 0, trash: 0 },
			},
		],
		projectState: null,
		projectMetadata: null,
		notificationSummariesByProject: { project: [summary] },
		notificationRevisionsByProject: { project: 1 },
		notificationPreferences: settings,
		notificationPresentation: state("browser", null),
	});
}
function grant(socket: FakeSocket, epoch = firstEpoch) {
	socket.message({ type: "notification_presentation", state: state("desktop", epoch), granted: true });
}
function delta(socket: FakeSocket, summary: typeof running = review, revision = 2) {
	socket.message({
		type: "task_notification",
		projectId: "project",
		notificationRevision: revision,
		summaries: [summary],
	});
}

describe("main-process notification subscription", () => {
	let controller: AbortController;
	let runtime: SelectedRuntime;
	let sockets: FakeSocket[];
	let subscription: DesktopNotificationSubscription;
	const notification = vi.fn();
	const badge = vi.fn();
	const factory = vi.fn();
	beforeEach(() => {
		vi.useFakeTimers();
		controller = new AbortController();
		runtime = {
			origin: "http://127.0.0.1:54321",
			generation,
			clientToken: "private-synthetic-token",
			signal: controller.signal,
		};
		sockets = [];
		notification.mockReset();
		badge.mockReset();
		factory.mockReset();
		factory.mockImplementation(() => {
			const socket = new FakeSocket();
			sockets.push(socket);
			return socket as unknown as WebSocket;
		});
	});
	afterEach(() => {
		subscription?.stop();
		vi.useRealTimers();
	});
	function start() {
		subscription = new DesktopNotificationSubscription({
			runtime,
			buildId: "synthetic",
			getFocus: () => ({ focused: false, currentProjectId: null }),
			onNotification: notification,
			onBadge: badge,
			createSocket: factory,
		});
		return sockets[0];
	}
	it("uses private generation-bound authentication, silently seeds, and renews without a renderer", () => {
		const socket = start();
		const [url, options] = factory.mock.calls[0];
		expect(new URL(url).searchParams.get("notificationOnly")).toBe("true");
		expect(options).toMatchObject({
			headers: {
				Origin: "app://quarterdeck",
				[DESKTOP_TOKEN_HEADER]: runtime.clientToken,
				"x-quarterdeck-runtime-generation": generation,
			},
			followRedirects: false,
		});
		baseline(socket, review);
		grant(socket);
		vi.advanceTimersByTime(5_000);
		expect(notification).not.toHaveBeenCalled();
		expect(JSON.parse(socket.send.mock.calls[0][0])).toEqual({
			type: "notification_presentation_renew",
			runtimeGeneration: generation,
			epoch: firstEpoch,
		});
		delta(socket, running, 2);
		delta(socket, review, 3);
		vi.advanceTimersByTime(500);
		expect(notification).toHaveBeenCalledWith(
			expect.objectContaining({ projectId: "project", eventType: "review", projectName: "Synthetic project" }),
		);
		controller.abort();
		expect(socket.close).toHaveBeenCalledOnce();
		expect(badge).toHaveBeenLastCalledWith(0);
	});
	it("reacquires after lease expiry on an open socket and delivers only new edges", () => {
		const first = start();
		baseline(first);
		grant(first);
		delta(first);
		vi.advanceTimersByTime(500);
		expect(notification).toHaveBeenCalledOnce();
		first.message({ type: "notification_presentation", state: state("browser", null) });
		expect(first.close).toHaveBeenCalledOnce();
		vi.advanceTimersByTime(500);
		const second = sockets[1];
		baseline(second, review);
		grant(second, secondEpoch);
		vi.advanceTimersByTime(500);
		expect(notification).toHaveBeenCalledOnce();
		delta(second, running, 2);
		delta(second, { ...review, updatedAt: 3, lastHookAt: 3 }, 3);
		vi.advanceTimersByTime(500);
		expect(notification).toHaveBeenCalledTimes(2);
	});
	it("waits behind another desktop owner and refuses stale generation delivery", () => {
		const socket = start();
		baseline(socket);
		socket.message({ type: "notification_presentation", state: state("desktop", firstEpoch), granted: false });
		delta(socket);
		vi.advanceTimersByTime(5_000);
		expect(socket.close).not.toHaveBeenCalled();
		expect(socket.send).not.toHaveBeenCalled();
		expect(notification).not.toHaveBeenCalled();
		socket.message({
			type: "notification_presentation",
			state: { ...state("desktop", firstEpoch), runtimeGeneration: secondEpoch },
			granted: true,
		});
		expect(socket.close).toHaveBeenCalledOnce();
		vi.advanceTimersByTime(10_000);
		expect(factory).toHaveBeenCalledOnce();
	});
	it("bounds missing baselines and retries socket construction errors without retaining a lease", () => {
		factory.mockImplementationOnce(() => {
			throw new Error("synthetic connection unavailable");
		});
		start();
		vi.advanceTimersByTime(500);
		const socket = sockets[0];
		grant(socket);
		vi.advanceTimersByTime(5_000);
		expect(socket.send).not.toHaveBeenCalled();
		expect(socket.close).toHaveBeenCalledOnce();
	});
	it("keeps in-app badge state and revalidates click fallback when native delivery is denied", () => {
		const socket = start();
		notification.mockImplementation(() => {
			throw new Error("denied");
		});
		baseline(socket);
		grant(socket);
		delta(socket);
		vi.advanceTimersByTime(500);
		expect(badge).toHaveBeenLastCalledWith(1);
		socket.message({
			type: "task_notification",
			projectId: "project",
			notificationRevision: 3,
			summaries: [],
			removedTaskIds: ["task"],
		});
		expect(subscription.resolveTarget({ projectId: "project", taskId: "task" })).toEqual({
			projectId: "project",
			taskId: null,
		});
	});
});
