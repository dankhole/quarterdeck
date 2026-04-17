import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
	createMockSession,
	defaultProps,
	HookHarness,
	type HookProps,
	setupTestHarness,
	type TestHarness,
} from "./audible-notifications-test-utils";

const playMock = vi.hoisted(() => vi.fn());
const ensureContextMock = vi.hoisted(() => vi.fn());
vi.mock("@/utils/notification-audio", () => ({
	notificationAudioPlayer: {
		play: playMock,
		ensureContext: ensureContextMock,
		dispose: vi.fn(),
	},
}));

describe("useAudibleNotifications — suppress current project", () => {
	let harness: TestHarness;

	beforeEach(() => {
		playMock.mockReset();
		ensureContextMock.mockReset();
		harness = setupTestHarness();
		vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
		vi.spyOn(document, "hasFocus").mockReturnValue(true);
	});

	afterEach(() => {
		harness.cleanup();
	});

	it("suppresses failure for current-project tasks when failure suppress is enabled", async () => {
		const props: HookProps = {
			...defaultProps(),
			audibleNotificationsOnlyWhenHidden: false,
			audibleNotificationSuppressCurrentProject: {
				permission: false,
				review: false,
				failure: true,
			},
			currentProjectId: "project-a",
			notificationWorkspaceIds: { "task-1": "project-a" },
		};

		await act(async () => {
			harness.root.render(
				<HookHarness
					{...props}
					notificationSessions={{
						"task-1": createMockSession({ taskId: "task-1", state: "running", reviewReason: null }),
					}}
				/>,
			);
		});

		await act(async () => {
			harness.root.render(
				<HookHarness
					{...props}
					notificationSessions={{
						"task-1": createMockSession({
							taskId: "task-1",
							state: "awaiting_review",
							reviewReason: "error",
						}),
					}}
				/>,
			);
		});

		harness.flushSettleWindow();
		expect(playMock).not.toHaveBeenCalled();
	});

	it("plays non-suppressed event types for current-project tasks", async () => {
		const props: HookProps = {
			...defaultProps(),
			audibleNotificationsOnlyWhenHidden: false,
			audibleNotificationSuppressCurrentProject: {
				permission: false,
				review: true,
				failure: false,
			},
			currentProjectId: "project-a",
			notificationWorkspaceIds: { "task-1": "project-a" },
		};

		await act(async () => {
			harness.root.render(
				<HookHarness
					{...props}
					notificationSessions={{
						"task-1": createMockSession({ taskId: "task-1", state: "running", reviewReason: null }),
					}}
				/>,
			);
		});

		await act(async () => {
			harness.root.render(
				<HookHarness
					{...props}
					notificationSessions={{
						"task-1": createMockSession({
							taskId: "task-1",
							state: "awaiting_review",
							reviewReason: "error",
						}),
					}}
				/>,
			);
		});

		harness.flushSettleWindow();
		expect(playMock).toHaveBeenCalledWith("failure", 0.7);
	});

	it("plays sounds for other-project tasks even when suppress is enabled", async () => {
		const props: HookProps = {
			...defaultProps(),
			audibleNotificationsOnlyWhenHidden: false,
			audibleNotificationSuppressCurrentProject: {
				permission: true,
				review: true,
				failure: true,
			},
			currentProjectId: "project-a",
			notificationWorkspaceIds: { "task-1": "project-b" },
		};

		await act(async () => {
			harness.root.render(
				<HookHarness
					{...props}
					notificationSessions={{
						"task-1": createMockSession({ taskId: "task-1", state: "running", reviewReason: null }),
					}}
				/>,
			);
		});

		await act(async () => {
			harness.root.render(
				<HookHarness
					{...props}
					notificationSessions={{
						"task-1": createMockSession({
							taskId: "task-1",
							state: "awaiting_review",
							reviewReason: "error",
						}),
					}}
				/>,
			);
		});

		harness.flushSettleWindow();
		expect(playMock).toHaveBeenCalledWith("failure", 0.7);
	});

	it("suppresses current-project and plays other-project in same batch", async () => {
		const props: HookProps = {
			...defaultProps(),
			audibleNotificationsOnlyWhenHidden: false,
			audibleNotificationSuppressCurrentProject: {
				permission: true,
				review: true,
				failure: true,
			},
			currentProjectId: "project-a",
			notificationWorkspaceIds: { "task-local": "project-a", "task-remote": "project-b" },
		};

		await act(async () => {
			harness.root.render(
				<HookHarness
					{...props}
					notificationSessions={{
						"task-local": createMockSession({ taskId: "task-local", state: "running" }),
						"task-remote": createMockSession({ taskId: "task-remote", state: "running" }),
					}}
				/>,
			);
		});

		await act(async () => {
			harness.root.render(
				<HookHarness
					{...props}
					notificationSessions={{
						"task-local": createMockSession({
							taskId: "task-local",
							state: "awaiting_review",
							reviewReason: "error",
						}),
						"task-remote": createMockSession({
							taskId: "task-remote",
							state: "awaiting_review",
							reviewReason: "exit",
							exitCode: 0,
						}),
					}}
				/>,
			);
		});

		harness.flushSettleWindow();
		expect(playMock).toHaveBeenCalledTimes(1);
		expect(playMock).toHaveBeenCalledWith("review", 0.7);
	});
});
