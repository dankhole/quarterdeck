import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createTestTaskOutstandingInteraction } from "@/test-utils/task-session-factory";
import {
	createMockSession,
	defaultProps,
	HookHarness,
	setupTestHarness,
	type TestHarness,
} from "./audible-notifications-test-utils";

const playMock = vi.hoisted(() => vi.fn());
const playContextMock = vi.hoisted(() => vi.fn());
const ensureContextMock = vi.hoisted(() => vi.fn());
vi.mock("@/utils/notification-audio", () => ({
	notificationAudioPlayer: {
		play: (eventType: string, volume: number, context: unknown) => {
			playContextMock(context);
			playMock(eventType, volume);
			return Promise.resolve("native" as const);
		},
		ensureContext: ensureContextMock,
		dispose: vi.fn(),
	},
}));

describe("useAudibleNotifications — basic sound events", () => {
	let harness: TestHarness;

	beforeEach(() => {
		playMock.mockReset();
		playContextMock.mockReset();
		ensureContextMock.mockReset();
		harness = setupTestHarness();
	});

	afterEach(() => {
		harness.cleanup();
	});

	it("plays permission sound when task stops with approval hook", async () => {
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
							outstandingInteraction: createTestTaskOutstandingInteraction({
								provider: "codex",
								kind: "permission",
								requestEventName: "PermissionRequest",
							}),
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
		expect(playMock).toHaveBeenCalledWith("permission", 0.7);
		expect(playContextMock).toHaveBeenCalledWith({ projectId: "project-unknown", taskId: "task-1" });
		expect(playMock).toHaveBeenCalledTimes(1);
	});

	it("plays review sound when task stops with non-permission hook", async () => {
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
								hookEventName: "SomeOtherHook",
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
		expect(playMock).toHaveBeenCalledWith("review", 0.7);
	});

	it("plays failure sound when session transitions to error", async () => {
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

	it("plays review sound when session exits successfully", async () => {
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
							reviewReason: "exit",
							exitCode: 0,
						}),
					}}
				/>,
			);
		});

		harness.flushSettleWindow();
		expect(playMock).toHaveBeenCalledWith("review", 0.7);
	});

	it("plays failure sound when session exits with non-zero exit code", async () => {
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
							reviewReason: "exit",
							exitCode: 1,
						}),
					}}
				/>,
			);
		});

		harness.flushSettleWindow();
		expect(playMock).toHaveBeenCalledWith("failure", 0.7);
	});

	it("plays failure sound when session exits with null exit code", async () => {
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
							reviewReason: "exit",
							exitCode: null,
						}),
					}}
				/>,
			);
		});

		harness.flushSettleWindow();
		expect(playMock).toHaveBeenCalledWith("failure", 0.7);
	});

	it("plays failure sound when session transitions to failed state", async () => {
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

	it("plays review sound for a structured Claude attention wait", async () => {
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
							reviewReason: "attention",
							outstandingInteraction: createTestTaskOutstandingInteraction(),
						}),
					}}
				/>,
			);
		});

		harness.flushSettleWindow();
		expect(playMock).toHaveBeenCalledWith("review", 0.7);
	});

	it("passes volume to audio player", async () => {
		const props = { ...defaultProps(), audibleNotificationVolume: 0.3 };

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
		expect(playMock).toHaveBeenCalledWith("failure", 0.3);
	});

	it("handles batch session updates (multiple tasks stop at once)", async () => {
		const props = defaultProps();

		await act(async () => {
			harness.root.render(
				<HookHarness
					{...props}
					notificationSessions={{
						"task-1": createMockSession({ taskId: "task-1", state: "running", reviewReason: null }),
						"task-2": createMockSession({ taskId: "task-2", state: "running", reviewReason: null }),
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
						"task-2": createMockSession({
							taskId: "task-2",
							state: "awaiting_review",
							reviewReason: "error",
						}),
					}}
				/>,
			);
		});

		harness.flushSettleWindow();
		expect(playMock).toHaveBeenCalledTimes(2);
		expect(playMock).toHaveBeenCalledWith("review", 0.7);
		expect(playMock).toHaveBeenCalledWith("failure", 0.7);
	});

	it("plays sound for tasks from different projects", async () => {
		const props = defaultProps();

		await act(async () => {
			harness.root.render(
				<HookHarness
					{...props}
					notificationSessions={{
						"ws1-task": createMockSession({ taskId: "ws1-task", state: "running" }),
						"ws2-task": createMockSession({ taskId: "ws2-task", state: "running" }),
					}}
				/>,
			);
		});

		await act(async () => {
			harness.root.render(
				<HookHarness
					{...props}
					notificationSessions={{
						"ws1-task": createMockSession({
							taskId: "ws1-task",
							state: "awaiting_review",
							reviewReason: "error",
						}),
						"ws2-task": createMockSession({
							taskId: "ws2-task",
							state: "awaiting_review",
							reviewReason: "exit",
							exitCode: 0,
						}),
					}}
				/>,
			);
		});

		harness.flushSettleWindow();
		expect(playMock).toHaveBeenCalledTimes(2);
		expect(playMock).toHaveBeenCalledWith("failure", 0.7);
		expect(playMock).toHaveBeenCalledWith("review", 0.7);
	});

	it("tracks same-ID tasks in different projects independently", async () => {
		const props = defaultProps({ currentProjectId: "project-a" });
		const running = (projectPath: string) =>
			createMockSession({ taskId: "shared", sessionLaunchPath: projectPath, state: "running" });

		await act(async () => {
			harness.root.render(
				<HookHarness
					{...props}
					notificationProjects={{
						"project-a": { sessions: { shared: running("/project-a") } },
						"project-b": { sessions: { shared: running("/project-b") } },
					}}
				/>,
			);
		});

		await act(async () => {
			harness.root.render(
				<HookHarness
					{...props}
					notificationProjects={{
						"project-a": {
							sessions: {
								shared: createMockSession({
									taskId: "shared",
									sessionLaunchPath: "/project-a",
									state: "awaiting_review",
									reviewReason: "error",
								}),
							},
						},
						"project-b": { sessions: { shared: running("/project-b") } },
					}}
				/>,
			);
		});

		harness.flushSettleWindow();
		expect(playContextMock).toHaveBeenCalledWith({ projectId: "project-a", taskId: "shared" });

		await act(async () => {
			harness.root.render(
				<HookHarness
					{...props}
					suppressedTaskIds={new Set(["shared"])}
					notificationProjects={{
						"project-a": {
							sessions: {
								shared: createMockSession({
									taskId: "shared",
									sessionLaunchPath: "/project-a",
									state: "awaiting_review",
									reviewReason: "error",
								}),
							},
						},
						"project-b": {
							sessions: {
								shared: createMockSession({
									taskId: "shared",
									sessionLaunchPath: "/project-b",
									state: "awaiting_review",
									reviewReason: "exit",
									exitCode: 0,
								}),
							},
						},
					}}
				/>,
			);
		});

		harness.flushSettleWindow();
		expect(playContextMock).toHaveBeenCalledWith({ projectId: "project-b", taskId: "shared" });
		expect(playMock).toHaveBeenCalledTimes(2);
	});
});
