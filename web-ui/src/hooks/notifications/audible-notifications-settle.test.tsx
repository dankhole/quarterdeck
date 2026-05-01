import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
	createMockSession,
	defaultProps,
	HookHarness,
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

describe("useAudibleNotifications — settle window & timing", () => {
	let harness: TestHarness;

	beforeEach(() => {
		playMock.mockReset();
		ensureContextMock.mockReset();
		harness = setupTestHarness();
	});

	afterEach(() => {
		harness.cleanup();
	});

	it("upgrades to higher-priority sound during settle window", async () => {
		const props = defaultProps();

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
							reviewReason: "hook",
							latestHookActivity: {
								hookEventName: "SomeHook",
								notificationType: null,
								activityText: null,
								toolName: null,
								toolInputSummary: null,
								finalMessage: null,
								source: null,
								conversationSummaryText: null,
							},
						}),
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
							reviewReason: "hook",
							latestHookActivity: {
								hookEventName: "PermissionRequest",
								notificationType: "permission.asked",
								activityText: "waiting for approval",
								toolName: null,
								toolInputSummary: null,
								finalMessage: null,
								source: null,
								conversationSummaryText: null,
							},
						}),
					}}
				/>,
			);
		});

		harness.flushSettleWindow();
		expect(playMock).toHaveBeenCalledWith("permission", 0.7);
		expect(playMock).toHaveBeenCalledTimes(1);
	});

	it("keeps the higher-priority queued sound if later stopped data downgrades before flush", async () => {
		const props = defaultProps();

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
							reviewReason: "hook",
							latestHookActivity: {
								hookEventName: "PermissionRequest",
								notificationType: "permission.asked",
								activityText: "waiting for approval",
								toolName: null,
								toolInputSummary: null,
								finalMessage: null,
								source: null,
								conversationSummaryText: null,
							},
						}),
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
							reviewReason: "hook",
							latestHookActivity: {
								hookEventName: "SomeHook",
								notificationType: null,
								activityText: null,
								toolName: null,
								toolInputSummary: null,
								finalMessage: null,
								source: null,
								conversationSummaryText: null,
							},
						}),
					}}
				/>,
			);
		});

		harness.flushSettleWindow();
		expect(playMock).toHaveBeenCalledWith("permission", 0.7);
		expect(playMock).toHaveBeenCalledTimes(1);
	});

	it("cancels pending sound immediately when task is locally suppressed", async () => {
		const props = defaultProps();

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
							reviewReason: "hook",
						}),
					}}
				/>,
			);
		});

		await act(async () => {
			harness.root.render(
				<HookHarness
					{...props}
					suppressedTaskIds={new Set(["task-1"])}
					notificationSessions={{
						"task-1": createMockSession({
							taskId: "task-1",
							state: "awaiting_review",
							reviewReason: "hook",
						}),
					}}
				/>,
			);
		});

		harness.flushSettleWindow();
		expect(playMock).not.toHaveBeenCalled();
	});

	it("cancels pending sound if task resumes during settle window", async () => {
		const props = defaultProps();

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
							reviewReason: "hook",
							latestHookActivity: {
								hookEventName: "SomeHook",
								notificationType: null,
								activityText: null,
								toolName: null,
								toolInputSummary: null,
								finalMessage: null,
								source: null,
								conversationSummaryText: null,
							},
						}),
					}}
				/>,
			);
		});

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

		harness.flushSettleWindow();
		expect(playMock).not.toHaveBeenCalled();
	});

	it("cancels pending sound if task is explicitly stopped during settle window", async () => {
		const props = defaultProps();

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
							reviewReason: "hook",
							latestHookActivity: {
								hookEventName: "PermissionRequest",
								notificationType: "permission.asked",
								activityText: "waiting for approval",
								toolName: null,
								toolInputSummary: null,
								finalMessage: null,
								source: null,
								conversationSummaryText: null,
							},
						}),
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
							reviewReason: "interrupted",
							latestHookActivity: null,
						}),
					}}
				/>,
			);
		});

		harness.flushSettleWindow();
		expect(playMock).not.toHaveBeenCalled();
	});

	it("fires non-hook events immediately without settle delay", async () => {
		const props = defaultProps();

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

		act(() => {
			vi.advanceTimersByTime(1);
		});
		expect(playMock).toHaveBeenCalledWith("failure", 0.7);
	});

	it("does not play hook event before settle window expires", async () => {
		const props = defaultProps();

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
							reviewReason: "hook",
							latestHookActivity: {
								hookEventName: "SomeHook",
								notificationType: null,
								activityText: null,
								toolName: null,
								toolInputSummary: null,
								finalMessage: null,
								source: null,
								conversationSummaryText: null,
							},
						}),
					}}
				/>,
			);
		});

		act(() => {
			vi.advanceTimersByTime(200);
		});
		expect(playMock).not.toHaveBeenCalled();

		harness.flushSettleWindow();
		expect(playMock).toHaveBeenCalledWith("review", 0.7);
	});

	it("registers one-time click listener that unlocks AudioContext", async () => {
		const addEventSpy = vi.spyOn(document, "addEventListener");
		const removeEventSpy = vi.spyOn(document, "removeEventListener");

		const props = defaultProps();

		await act(async () => {
			harness.root.render(<HookHarness {...props} />);
		});

		const clickCall = addEventSpy.mock.calls.find((call) => call[0] === "click");
		expect(clickCall).toBeDefined();
		const handler = clickCall![1] as EventListener;

		await act(async () => {
			handler(new MouseEvent("click"));
		});

		expect(ensureContextMock).toHaveBeenCalledOnce();
		expect(removeEventSpy).toHaveBeenCalledWith("click", handler);
	});
});
