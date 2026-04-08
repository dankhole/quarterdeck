import { act, useEffect } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { useAudibleNotifications } from "@/hooks/use-audible-notifications";
import type { RuntimeTaskSessionSummary } from "@/runtime/types";

// --- Module mock for notification-audio ---

const playMock = vi.hoisted(() => vi.fn());
const ensureContextMock = vi.hoisted(() => vi.fn());
vi.mock("@/utils/notification-audio", () => ({
	notificationAudioPlayer: {
		play: playMock,
		ensureContext: ensureContextMock,
		dispose: vi.fn(),
	},
}));

// --- Mock session factory ---

function createMockSession(overrides: Partial<RuntimeTaskSessionSummary> = {}): RuntimeTaskSessionSummary {
	return {
		taskId: "task-1",
		state: "idle",
		agentId: "claude",
		workspacePath: "/tmp/repo",
		pid: null,
		startedAt: null,
		updatedAt: Date.now(),
		lastOutputAt: null,
		reviewReason: null,
		exitCode: null,
		lastHookAt: null,
		latestHookActivity: null,
		latestTurnCheckpoint: null,
		previousTurnCheckpoint: null,
		...overrides,
	};
}

// --- Hook harness ---

interface HookProps {
	activeWorkspaceId: string | null;
	taskSessions: Record<string, RuntimeTaskSessionSummary>;
	audibleNotificationsEnabled: boolean;
	audibleNotificationVolume: number;
	audibleNotificationEvents: {
		permission: boolean;
		review: boolean;
		failure: boolean;
		completion: boolean;
	};
	audibleNotificationsOnlyWhenHidden: boolean;
}

function defaultProps(): HookProps {
	return {
		activeWorkspaceId: "ws-1",
		taskSessions: {},
		audibleNotificationsEnabled: true,
		audibleNotificationVolume: 0.7,
		audibleNotificationEvents: {
			permission: true,
			review: true,
			failure: true,
			completion: true,
		},
		audibleNotificationsOnlyWhenHidden: true,
	};
}

function HookHarness({ onRender, ...props }: HookProps & { onRender?: () => void }): null {
	useAudibleNotifications(props);
	useEffect(() => {
		onRender?.();
	});
	return null;
}

// --- Test setup ---

/** Settle window used by the hook (must match SETTLE_WINDOW_MS in source). */
const SETTLE_MS = 1500;

describe("useAudibleNotifications", () => {
	let container: HTMLDivElement;
	let root: Root;
	let previousActEnvironment: boolean | undefined;

	beforeEach(() => {
		vi.useFakeTimers();
		playMock.mockReset();
		ensureContextMock.mockReset();

		// Mock tab as hidden so sounds play by default.
		vi.spyOn(document, "visibilityState", "get").mockReturnValue("hidden");
		vi.spyOn(document, "hasFocus").mockReturnValue(false);

		previousActEnvironment = (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean })
			.IS_REACT_ACT_ENVIRONMENT;
		(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
		container = document.createElement("div");
		document.body.appendChild(container);
		root = createRoot(container);
	});

	/** Flush the settle window so pending sounds fire. */
	function flushSettleWindow(): void {
		act(() => {
			vi.advanceTimersByTime(SETTLE_MS + 50);
		});
	}

	afterEach(() => {
		act(() => {
			root.unmount();
		});
		container.remove();
		vi.useRealTimers();
		vi.restoreAllMocks();
		if (previousActEnvironment === undefined) {
			delete (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
		} else {
			(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
				previousActEnvironment;
		}
	});

	// --- Basic sound events ---

	it("plays permission sound when task stops with approval hook", async () => {
		const props = defaultProps();

		// Start with running task.
		await act(async () => {
			root.render(
				<HookHarness
					{...props}
					taskSessions={{
						"task-1": createMockSession({ taskId: "task-1", state: "running", reviewReason: null }),
					}}
				/>,
			);
		});

		// Transition to awaiting_review with permission activity.
		await act(async () => {
			root.render(
				<HookHarness
					{...props}
					taskSessions={{
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
							},
						}),
					}}
				/>,
			);
		});

		flushSettleWindow();
		expect(playMock).toHaveBeenCalledWith("permission", 0.7);
		expect(playMock).toHaveBeenCalledTimes(1);
	});

	it("plays review sound when task stops with non-permission hook", async () => {
		const props = defaultProps();

		await act(async () => {
			root.render(
				<HookHarness
					{...props}
					taskSessions={{
						"task-1": createMockSession({ taskId: "task-1", state: "running", reviewReason: null }),
					}}
				/>,
			);
		});

		await act(async () => {
			root.render(
				<HookHarness
					{...props}
					taskSessions={{
						"task-1": createMockSession({
							taskId: "task-1",
							state: "awaiting_review",
							reviewReason: "hook",
							latestHookActivity: {
								hookEventName: "SomeOtherHook",
								notificationType: null,
								activityText: null,
								toolName: null,
								toolInputSummary: null,
								finalMessage: null,
								source: null,
							},
						}),
					}}
				/>,
			);
		});

		flushSettleWindow();
		expect(playMock).toHaveBeenCalledWith("review", 0.7);
	});

	it("plays failure sound when session transitions to error", async () => {
		const props = defaultProps();

		await act(async () => {
			root.render(
				<HookHarness
					{...props}
					taskSessions={{
						"task-1": createMockSession({ taskId: "task-1", state: "running", reviewReason: null }),
					}}
				/>,
			);
		});

		await act(async () => {
			root.render(
				<HookHarness
					{...props}
					taskSessions={{
						"task-1": createMockSession({
							taskId: "task-1",
							state: "awaiting_review",
							reviewReason: "error",
						}),
					}}
				/>,
			);
		});

		flushSettleWindow();
		expect(playMock).toHaveBeenCalledWith("failure", 0.7);
	});

	it("plays completion sound when session exits successfully", async () => {
		const props = defaultProps();

		await act(async () => {
			root.render(
				<HookHarness
					{...props}
					taskSessions={{
						"task-1": createMockSession({ taskId: "task-1", state: "running", reviewReason: null }),
					}}
				/>,
			);
		});

		await act(async () => {
			root.render(
				<HookHarness
					{...props}
					taskSessions={{
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

		flushSettleWindow();
		expect(playMock).toHaveBeenCalledWith("completion", 0.7);
	});

	// --- Master toggle ---

	it("does not play when master toggle is disabled", async () => {
		const props = { ...defaultProps(), audibleNotificationsEnabled: false };

		await act(async () => {
			root.render(
				<HookHarness
					{...props}
					taskSessions={{
						"task-1": createMockSession({ taskId: "task-1", state: "running", reviewReason: null }),
					}}
				/>,
			);
		});

		await act(async () => {
			root.render(
				<HookHarness
					{...props}
					taskSessions={{
						"task-1": createMockSession({
							taskId: "task-1",
							state: "awaiting_review",
							reviewReason: "error",
						}),
					}}
				/>,
			);
		});

		flushSettleWindow();
		expect(playMock).not.toHaveBeenCalled();
	});

	// --- Per-event toggles ---

	it("does not play permission sound when permission event is disabled", async () => {
		const props = {
			...defaultProps(),
			audibleNotificationEvents: { permission: false, review: true, failure: true, completion: true },
		};

		await act(async () => {
			root.render(
				<HookHarness
					{...props}
					taskSessions={{
						"task-1": createMockSession({ taskId: "task-1", state: "running", reviewReason: null }),
					}}
				/>,
			);
		});

		await act(async () => {
			root.render(
				<HookHarness
					{...props}
					taskSessions={{
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
							},
						}),
					}}
				/>,
			);
		});

		flushSettleWindow();
		expect(playMock).not.toHaveBeenCalled();
	});

	it("does not play review sound when review event is disabled", async () => {
		const props = {
			...defaultProps(),
			audibleNotificationEvents: { permission: true, review: false, failure: true, completion: true },
		};

		await act(async () => {
			root.render(
				<HookHarness
					{...props}
					taskSessions={{
						"task-1": createMockSession({ taskId: "task-1", state: "running", reviewReason: null }),
					}}
				/>,
			);
		});

		await act(async () => {
			root.render(
				<HookHarness
					{...props}
					taskSessions={{
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
							},
						}),
					}}
				/>,
			);
		});

		flushSettleWindow();
		expect(playMock).not.toHaveBeenCalled();
	});

	it("does not play failure sound when failure event is disabled", async () => {
		const props = {
			...defaultProps(),
			audibleNotificationEvents: { permission: true, review: true, failure: false, completion: true },
		};

		await act(async () => {
			root.render(
				<HookHarness
					{...props}
					taskSessions={{
						"task-1": createMockSession({ taskId: "task-1", state: "running", reviewReason: null }),
					}}
				/>,
			);
		});

		await act(async () => {
			root.render(
				<HookHarness
					{...props}
					taskSessions={{
						"task-1": createMockSession({
							taskId: "task-1",
							state: "awaiting_review",
							reviewReason: "error",
						}),
					}}
				/>,
			);
		});

		flushSettleWindow();
		expect(playMock).not.toHaveBeenCalled();
	});

	it("does not play completion sound when completion event is disabled", async () => {
		const props = {
			...defaultProps(),
			audibleNotificationEvents: { permission: true, review: true, failure: true, completion: false },
		};

		await act(async () => {
			root.render(
				<HookHarness
					{...props}
					taskSessions={{
						"task-1": createMockSession({ taskId: "task-1", state: "running", reviewReason: null }),
					}}
				/>,
			);
		});

		await act(async () => {
			root.render(
				<HookHarness
					{...props}
					taskSessions={{
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

		flushSettleWindow();
		expect(playMock).not.toHaveBeenCalled();
	});

	// --- Visibility gating ---

	it("does not play when tab is visible and onlyWhenHidden is true", async () => {
		vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");

		const props = defaultProps();

		await act(async () => {
			root.render(
				<HookHarness
					{...props}
					taskSessions={{
						"task-1": createMockSession({ taskId: "task-1", state: "running", reviewReason: null }),
					}}
				/>,
			);
		});

		await act(async () => {
			root.render(
				<HookHarness
					{...props}
					taskSessions={{
						"task-1": createMockSession({
							taskId: "task-1",
							state: "awaiting_review",
							reviewReason: "error",
						}),
					}}
				/>,
			);
		});

		flushSettleWindow();
		expect(playMock).not.toHaveBeenCalled();
	});

	// --- Initial snapshot ---

	it("does not play for initial snapshot load", async () => {
		const props = defaultProps();

		// First render with error session already present — treated as initial snapshot.
		await act(async () => {
			root.render(
				<HookHarness
					{...props}
					taskSessions={{
						"task-1": createMockSession({
							taskId: "task-1",
							state: "awaiting_review",
							reviewReason: "error",
						}),
					}}
				/>,
			);
		});

		flushSettleWindow();
		expect(playMock).not.toHaveBeenCalled();
	});

	// --- Volume passthrough ---

	it("passes volume to audio player", async () => {
		const props = { ...defaultProps(), audibleNotificationVolume: 0.3 };

		await act(async () => {
			root.render(
				<HookHarness
					{...props}
					taskSessions={{
						"task-1": createMockSession({ taskId: "task-1", state: "running", reviewReason: null }),
					}}
				/>,
			);
		});

		await act(async () => {
			root.render(
				<HookHarness
					{...props}
					taskSessions={{
						"task-1": createMockSession({
							taskId: "task-1",
							state: "awaiting_review",
							reviewReason: "error",
						}),
					}}
				/>,
			);
		});

		flushSettleWindow();
		expect(playMock).toHaveBeenCalledWith("failure", 0.3);
	});

	// --- Batch session updates ---

	it("handles batch session updates (multiple tasks stop at once)", async () => {
		const props = defaultProps();

		await act(async () => {
			root.render(
				<HookHarness
					{...props}
					taskSessions={{
						"task-1": createMockSession({ taskId: "task-1", state: "running", reviewReason: null }),
						"task-2": createMockSession({ taskId: "task-2", state: "running", reviewReason: null }),
					}}
				/>,
			);
		});

		await act(async () => {
			root.render(
				<HookHarness
					{...props}
					taskSessions={{
						"task-1": createMockSession({
							taskId: "task-1",
							state: "awaiting_review",
							reviewReason: "exit",
							exitCode: 0,
						}),
						"task-2": createMockSession({
							taskId: "task-2",
							state: "awaiting_review",
							reviewReason: "error",
						}),
					}}
				/>,
			);
		});

		flushSettleWindow();
		expect(playMock).toHaveBeenCalledTimes(2);
		expect(playMock).toHaveBeenCalledWith("completion", 0.7);
		expect(playMock).toHaveBeenCalledWith("failure", 0.7);
	});

	// --- Workspace ---

	it("does not play when activeWorkspaceId is null", async () => {
		const props = { ...defaultProps(), activeWorkspaceId: null };

		await act(async () => {
			root.render(
				<HookHarness
					{...props}
					taskSessions={{
						"task-1": createMockSession({ taskId: "task-1", state: "running", reviewReason: null }),
					}}
				/>,
			);
		});

		await act(async () => {
			root.render(
				<HookHarness
					{...props}
					taskSessions={{
						"task-1": createMockSession({
							taskId: "task-1",
							state: "awaiting_review",
							reviewReason: "error",
						}),
					}}
				/>,
			);
		});

		flushSettleWindow();
		expect(playMock).not.toHaveBeenCalled();
	});

	// --- Non-zero and null exit codes ---

	it("plays failure sound when session exits with non-zero exit code", async () => {
		const props = defaultProps();

		await act(async () => {
			root.render(
				<HookHarness
					{...props}
					taskSessions={{
						"task-1": createMockSession({ taskId: "task-1", state: "running", reviewReason: null }),
					}}
				/>,
			);
		});

		await act(async () => {
			root.render(
				<HookHarness
					{...props}
					taskSessions={{
						"task-1": createMockSession({
							taskId: "task-1",
							state: "awaiting_review",
							reviewReason: "exit",
							exitCode: 1,
						}),
					}}
				/>,
			);
		});

		flushSettleWindow();
		expect(playMock).toHaveBeenCalledWith("failure", 0.7);
	});

	it("plays failure sound when session exits with null exit code", async () => {
		const props = defaultProps();

		await act(async () => {
			root.render(
				<HookHarness
					{...props}
					taskSessions={{
						"task-1": createMockSession({ taskId: "task-1", state: "running", reviewReason: null }),
					}}
				/>,
			);
		});

		await act(async () => {
			root.render(
				<HookHarness
					{...props}
					taskSessions={{
						"task-1": createMockSession({
							taskId: "task-1",
							state: "awaiting_review",
							reviewReason: "exit",
							exitCode: null,
						}),
					}}
				/>,
			);
		});

		flushSettleWindow();
		expect(playMock).toHaveBeenCalledWith("failure", 0.7);
	});

	// --- PTY crash ---

	it("plays failure sound when session transitions to failed state", async () => {
		const props = defaultProps();

		await act(async () => {
			root.render(
				<HookHarness
					{...props}
					taskSessions={{
						"task-1": createMockSession({ taskId: "task-1", state: "running", reviewReason: null }),
					}}
				/>,
			);
		});

		await act(async () => {
			root.render(
				<HookHarness
					{...props}
					taskSessions={{
						"task-1": createMockSession({
							taskId: "task-1",
							state: "failed",
							reviewReason: null,
						}),
					}}
				/>,
			);
		});

		flushSettleWindow();
		expect(playMock).toHaveBeenCalledWith("failure", 0.7);
	});

	// --- Silent states ---

	it("does not play when session is interrupted", async () => {
		const props = defaultProps();

		await act(async () => {
			root.render(
				<HookHarness
					{...props}
					taskSessions={{
						"task-1": createMockSession({ taskId: "task-1", state: "running", reviewReason: null }),
					}}
				/>,
			);
		});

		await act(async () => {
			root.render(
				<HookHarness
					{...props}
					taskSessions={{
						"task-1": createMockSession({
							taskId: "task-1",
							state: "interrupted",
							reviewReason: null,
						}),
					}}
				/>,
			);
		});

		flushSettleWindow();
		expect(playMock).not.toHaveBeenCalled();
	});

	it("does not play when review reason is interrupted", async () => {
		const props = defaultProps();

		await act(async () => {
			root.render(
				<HookHarness
					{...props}
					taskSessions={{
						"task-1": createMockSession({ taskId: "task-1", state: "running", reviewReason: null }),
					}}
				/>,
			);
		});

		await act(async () => {
			root.render(
				<HookHarness
					{...props}
					taskSessions={{
						"task-1": createMockSession({
							taskId: "task-1",
							state: "awaiting_review",
							reviewReason: "interrupted",
						}),
					}}
				/>,
			);
		});

		flushSettleWindow();
		expect(playMock).not.toHaveBeenCalled();
	});

	// --- Attention ---

	it("plays review sound when review reason is attention", async () => {
		const props = defaultProps();

		await act(async () => {
			root.render(
				<HookHarness
					{...props}
					taskSessions={{
						"task-1": createMockSession({ taskId: "task-1", state: "running", reviewReason: null }),
					}}
				/>,
			);
		});

		await act(async () => {
			root.render(
				<HookHarness
					{...props}
					taskSessions={{
						"task-1": createMockSession({
							taskId: "task-1",
							state: "awaiting_review",
							reviewReason: "attention",
						}),
					}}
				/>,
			);
		});

		flushSettleWindow();
		expect(playMock).toHaveBeenCalledWith("review", 0.7);
	});

	// --- Workspace switch ---

	it("clears state on workspace switch — no stale sounds", async () => {
		const props = defaultProps();

		// Render with ws-1 and a running session.
		await act(async () => {
			root.render(
				<HookHarness
					{...props}
					activeWorkspaceId="ws-1"
					taskSessions={{
						"task-1": createMockSession({ taskId: "task-1", state: "running", reviewReason: null }),
					}}
				/>,
			);
		});

		// Switch to ws-2 with an error session already present.
		// The ref was cleared, so this is treated as initial snapshot — no sound.
		await act(async () => {
			root.render(
				<HookHarness
					{...props}
					activeWorkspaceId="ws-2"
					taskSessions={{
						"task-2": createMockSession({
							taskId: "task-2",
							state: "awaiting_review",
							reviewReason: "error",
						}),
					}}
				/>,
			);
		});

		flushSettleWindow();
		expect(playMock).not.toHaveBeenCalled();
	});

	// --- Click listener ---

	it("registers one-time click listener that unlocks AudioContext", async () => {
		const addEventSpy = vi.spyOn(document, "addEventListener");
		const removeEventSpy = vi.spyOn(document, "removeEventListener");

		const props = defaultProps();

		await act(async () => {
			root.render(<HookHarness {...props} />);
		});

		// Verify click listener registered.
		const clickCall = addEventSpy.mock.calls.find((call) => call[0] === "click");
		expect(clickCall).toBeDefined();
		const handler = clickCall![1] as EventListener;

		// Simulate first click.
		await act(async () => {
			handler(new MouseEvent("click"));
		});

		expect(ensureContextMock).toHaveBeenCalledOnce();

		// Verify listener removed after first click.
		expect(removeEventSpy).toHaveBeenCalledWith("click", handler);
	});

	// --- Session removal ---

	it("handles session removed from taskSessions", async () => {
		const props = defaultProps();

		await act(async () => {
			root.render(
				<HookHarness
					{...props}
					taskSessions={{
						"task-1": createMockSession({ taskId: "task-1", state: "running", reviewReason: null }),
					}}
				/>,
			);
		});

		// Remove task-1 from sessions entirely.
		await act(async () => {
			root.render(<HookHarness {...props} taskSessions={{}} />);
		});

		// No crash, no sound.
		flushSettleWindow();
		expect(playMock).not.toHaveBeenCalled();
	});

	// --- Settle window: priority upgrade ---

	it("upgrades to higher-priority sound during settle window", async () => {
		const props = defaultProps();

		// Start with running task.
		await act(async () => {
			root.render(
				<HookHarness
					{...props}
					taskSessions={{
						"task-1": createMockSession({ taskId: "task-1", state: "running", reviewReason: null }),
					}}
				/>,
			);
		});

		// First transition: hook with no activity (review).
		await act(async () => {
			root.render(
				<HookHarness
					{...props}
					taskSessions={{
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
							},
						}),
					}}
				/>,
			);
		});

		// Activity arrives during settle window — now it's a permission request.
		await act(async () => {
			root.render(
				<HookHarness
					{...props}
					taskSessions={{
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
							},
						}),
					}}
				/>,
			);
		});

		flushSettleWindow();
		// Should play permission (priority 1), not review (priority 0).
		expect(playMock).toHaveBeenCalledWith("permission", 0.7);
		expect(playMock).toHaveBeenCalledTimes(1);
	});

	// --- Settle window: cancel on resume ---

	it("cancels pending sound if task resumes during settle window", async () => {
		const props = defaultProps();

		await act(async () => {
			root.render(
				<HookHarness
					{...props}
					taskSessions={{
						"task-1": createMockSession({ taskId: "task-1", state: "running", reviewReason: null }),
					}}
				/>,
			);
		});

		// Task stops.
		await act(async () => {
			root.render(
				<HookHarness
					{...props}
					taskSessions={{
						"task-1": createMockSession({
							taskId: "task-1",
							state: "awaiting_review",
							reviewReason: "error",
						}),
					}}
				/>,
			);
		});

		// Task resumes before settle window expires.
		await act(async () => {
			root.render(
				<HookHarness
					{...props}
					taskSessions={{
						"task-1": createMockSession({ taskId: "task-1", state: "running", reviewReason: null }),
					}}
				/>,
			);
		});

		flushSettleWindow();
		expect(playMock).not.toHaveBeenCalled();
	});

	// --- No sound before settle window expires ---

	it("does not play before settle window expires", async () => {
		const props = defaultProps();

		await act(async () => {
			root.render(
				<HookHarness
					{...props}
					taskSessions={{
						"task-1": createMockSession({ taskId: "task-1", state: "running", reviewReason: null }),
					}}
				/>,
			);
		});

		await act(async () => {
			root.render(
				<HookHarness
					{...props}
					taskSessions={{
						"task-1": createMockSession({
							taskId: "task-1",
							state: "awaiting_review",
							reviewReason: "error",
						}),
					}}
				/>,
			);
		});

		// Advance less than settle window.
		act(() => {
			vi.advanceTimersByTime(500);
		});
		expect(playMock).not.toHaveBeenCalled();

		// Now flush the rest.
		flushSettleWindow();
		expect(playMock).toHaveBeenCalledWith("failure", 0.7);
	});
});
