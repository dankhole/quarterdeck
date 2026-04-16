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

describe("useAudibleNotifications — toggles & visibility", () => {
	let harness: TestHarness;

	beforeEach(() => {
		playMock.mockReset();
		ensureContextMock.mockReset();
		harness = setupTestHarness();
	});

	afterEach(() => {
		harness.cleanup();
	});

	// --- Master toggle ---

	it("does not play when master toggle is disabled", async () => {
		const props = { ...defaultProps(), audibleNotificationsEnabled: false };

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

	// --- Per-event toggles ---

	it("does not play permission sound when permission event is disabled", async () => {
		const props = {
			...defaultProps(),
			audibleNotificationEvents: { permission: false, review: true, failure: true },
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
							reviewReason: "hook",
							latestHookActivity: {
								hookEventName: "PermissionRequest",
								notificationType: "permission.asked",
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
		expect(playMock).not.toHaveBeenCalled();
	});

	it("does not play review sound when review event is disabled", async () => {
		const props = {
			...defaultProps(),
			audibleNotificationEvents: { permission: true, review: false, failure: true },
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
		expect(playMock).not.toHaveBeenCalled();
	});

	it("does not play failure sound when failure event is disabled", async () => {
		const props = {
			...defaultProps(),
			audibleNotificationEvents: { permission: true, review: true, failure: false },
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

	it("does not play review sound for successful exit when review event is disabled", async () => {
		const props = {
			...defaultProps(),
			audibleNotificationEvents: { permission: true, review: false, failure: true },
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
							reviewReason: "exit",
							exitCode: 0,
						}),
					}}
				/>,
			);
		});

		harness.flushSettleWindow();
		expect(playMock).not.toHaveBeenCalled();
	});

	// --- Visibility gating ---

	it("does not play when tab is visible and focused and onlyWhenHidden is true", async () => {
		vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
		vi.spyOn(document, "hasFocus").mockReturnValue(true);

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

		harness.flushSettleWindow();
		expect(playMock).not.toHaveBeenCalled();
	});

	it("plays when tab is visible but window is unfocused and onlyWhenHidden is true", async () => {
		vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
		vi.spyOn(document, "hasFocus").mockReturnValue(false);

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

		harness.flushSettleWindow();
		expect(playMock).toHaveBeenCalledWith("failure", 0.7);
	});

	// --- Silent states ---

	it("does not play when session is interrupted", async () => {
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
							state: "interrupted",
							reviewReason: null,
						}),
					}}
				/>,
			);
		});

		harness.flushSettleWindow();
		expect(playMock).not.toHaveBeenCalled();
	});

	it("does not play when review reason is interrupted", async () => {
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
							reviewReason: "interrupted",
						}),
					}}
				/>,
			);
		});

		harness.flushSettleWindow();
		expect(playMock).not.toHaveBeenCalled();
	});

	// --- Initial snapshot ---

	it("does not play for initial snapshot load", async () => {
		const props = defaultProps();

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

	// --- Session removal ---

	it("handles session removed from notificationSessions", async () => {
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
			harness.root.render(<HookHarness {...props} notificationSessions={{}} />);
		});

		harness.flushSettleWindow();
		expect(playMock).not.toHaveBeenCalled();
	});
});
