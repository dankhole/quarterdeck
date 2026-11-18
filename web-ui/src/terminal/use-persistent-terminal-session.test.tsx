import { act, StrictMode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RuntimeTaskSessionSummary } from "@/runtime/types";
import type { TaskTerminalSubscriber } from "@/terminal/terminal-reuse-manager";
import { usePersistentTerminalSession } from "@/terminal/use-persistent-terminal-session";
import { createTestTaskSessionSummary } from "@/test-utils/task-session-factory";

const acquireTaskTerminalMock = vi.hoisted(() => vi.fn());
const stageTaskTerminalContainerMock = vi.hoisted(() => vi.fn());
const releaseTaskTerminalMock = vi.hoisted(() => vi.fn());
const isDedicatedTerminalTaskIdMock = vi.hoisted(() => vi.fn());
const ensureDedicatedTerminalMock = vi.hoisted(() => vi.fn());
const disposeDedicatedTerminalMock = vi.hoisted(() => vi.fn());
const registerTerminalControllerMock = vi.hoisted(() => vi.fn());

vi.mock("@/terminal/terminal-reuse-manager", () => ({
	acquireTaskTerminal: acquireTaskTerminalMock,
	stageTaskTerminalContainer: stageTaskTerminalContainerMock,
	releaseTaskTerminal: releaseTaskTerminalMock,
}));

vi.mock("@/terminal/terminal-pool", () => ({
	isDedicatedTerminalTaskId: isDedicatedTerminalTaskIdMock,
	ensureDedicatedTerminal: ensureDedicatedTerminalMock,
	disposeDedicatedTerminal: disposeDedicatedTerminalMock,
}));

vi.mock("@/terminal/terminal-controller-registry", () => ({
	registerTerminalController: registerTerminalControllerMock,
}));

function createTerminalSlotMock() {
	return {
		subscribe: vi.fn((_subscriber: TaskTerminalSubscriber) => vi.fn()),
		attachToStageContainer: vi.fn(),
		show: vi.fn(),
		hide: vi.fn(),
		park: vi.fn(),
		reset: vi.fn(),
		requestRestore: vi.fn(),
		input: vi.fn(() => true),
		paste: vi.fn(() => true),
		waitForLikelyPrompt: vi.fn(async () => true),
		clear: vi.fn(),
		stop: vi.fn(async () => {}),
	};
}

function HookHarness({
	taskId,
	projectId,
	sessionStartedAt,
	enabled = true,
	isVisible = true,
	cursorColor = "cursor-color",
	onSummary,
	onConnectionReady,
}: {
	taskId: string;
	projectId: string | null;
	sessionStartedAt: number | null;
	enabled?: boolean;
	isVisible?: boolean;
	cursorColor?: string;
	onSummary?: (projectId: string, summary: RuntimeTaskSessionSummary) => void;
	onConnectionReady?: (taskId: string) => void;
}) {
	const { containerRef, isLoading, isContentPending } = usePersistentTerminalSession({
		taskId,
		projectId,
		enabled,
		isVisible,
		onSummary,
		onConnectionReady,
		sessionStartedAt,
		sessionInstanceId: "session-1",
		terminalBackgroundColor: "terminal-background",
		cursorColor,
	});

	return (
		<>
			<output>{isLoading ? "connecting" : isContentPending ? "starting" : "ready"}</output>
			<div ref={containerRef} />
		</>
	);
}

describe("usePersistentTerminalSession", () => {
	let container: HTMLDivElement;
	let root: Root;
	let previousActEnvironment: boolean | undefined;

	beforeEach(() => {
		acquireTaskTerminalMock.mockReset();
		stageTaskTerminalContainerMock.mockReset();
		releaseTaskTerminalMock.mockReset();
		isDedicatedTerminalTaskIdMock.mockReset();
		ensureDedicatedTerminalMock.mockReset();
		disposeDedicatedTerminalMock.mockReset();
		registerTerminalControllerMock.mockReset();
		registerTerminalControllerMock.mockImplementation(
			(
				_taskId,
				_controller,
				_scope,
				subscribeToReadiness?: (onReadyChange: (ready: boolean) => void) => () => void,
			) => subscribeToReadiness?.(() => {}) ?? (() => {}),
		);
		// Default: regular task IDs go through pool path
		isDedicatedTerminalTaskIdMock.mockReturnValue(false);
		acquireTaskTerminalMock.mockImplementation(() => createTerminalSlotMock());
		ensureDedicatedTerminalMock.mockImplementation(() => createTerminalSlotMock());
		previousActEnvironment = (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean })
			.IS_REACT_ACT_ENVIRONMENT;
		(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
		container = document.createElement("div");
		document.body.appendChild(container);
		root = createRoot(container);
	});

	afterEach(() => {
		act(() => {
			root.unmount();
		});
		container.remove();
		if (previousActEnvironment === undefined) {
			delete (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
		} else {
			(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
				previousActEnvironment;
		}
	});

	it.each([false, true])(
		"preserves the subscription project when forwarding summaries (dedicated: %s)",
		async (dedicated) => {
			isDedicatedTerminalTaskIdMock.mockReturnValue(dedicated);
			const terminal = createTerminalSlotMock();
			acquireTaskTerminalMock.mockReturnValue(terminal);
			ensureDedicatedTerminalMock.mockReturnValue(terminal);
			const oldCallback = vi.fn();
			const currentCallback = vi.fn();
			await act(async () => {
				root.render(
					<HookHarness taskId="task-a" projectId="project-1" sessionStartedAt={100} onSummary={oldCallback} />,
				);
			});
			const oldSubscriber = terminal.subscribe.mock.calls[0]?.[0];
			expect(oldSubscriber?.onSummary).toBeTypeOf("function");
			await act(async () => {
				root.render(
					<HookHarness taskId="task-a" projectId="project-2" sessionStartedAt={100} onSummary={currentCallback} />,
				);
			});
			const summary = createTestTaskSessionSummary({ taskId: "task-a" });
			await act(async () => {
				oldSubscriber?.onSummary?.(summary);
			});
			expect(currentCallback).toHaveBeenCalledWith("project-1", summary);
			expect(oldCallback).not.toHaveBeenCalled();
			terminal.subscribe.mock.calls[2]?.[0].onSummary?.(summary);
			expect(currentCallback).toHaveBeenLastCalledWith("project-2", summary);
		},
	);

	it("acquires slot from pool on mount", async () => {
		await act(async () => {
			root.render(<HookHarness taskId="task-a" projectId="project-1" sessionStartedAt={100} />);
		});

		expect(acquireTaskTerminalMock).toHaveBeenCalledTimes(1);
		expect(acquireTaskTerminalMock).toHaveBeenCalledWith("task-a", "project-1");
	});

	it("keeps agent startup presentation separate from input connection readiness", async () => {
		const terminal = createTerminalSlotMock();
		acquireTaskTerminalMock.mockReturnValue(terminal);
		await act(async () => {
			root.render(<HookHarness taskId="task-a" projectId="project-1" sessionStartedAt={100} />);
		});
		const subscriber = terminal.subscribe.mock.calls[0]![0];
		await act(async () => {
			subscriber.onContentPending?.(true);
			subscriber.onConnectionReady?.("task-a");
		});
		expect(container.querySelector("output")?.textContent).toBe("starting");
		await act(async () => subscriber.onContentPending?.(false));
		expect(container.querySelector("output")?.textContent).toBe("ready");
	});

	it("shows slot into container", async () => {
		const terminal = createTerminalSlotMock();
		acquireTaskTerminalMock.mockReturnValue(terminal);

		await act(async () => {
			root.render(<HookHarness taskId="task-a" projectId="project-1" sessionStartedAt={100} />);
		});

		expect(terminal.show).toHaveBeenCalledTimes(1);
	});

	it("does not dispose slot on task switch (pool manages lifecycle)", async () => {
		await act(async () => {
			root.render(<HookHarness taskId="task-a" projectId="project-1" sessionStartedAt={100} />);
		});

		await act(async () => {
			root.render(<HookHarness taskId="task-b" projectId="project-1" sessionStartedAt={200} />);
		});

		expect(releaseTaskTerminalMock).not.toHaveBeenCalled();
		expect(acquireTaskTerminalMock).toHaveBeenCalledTimes(2);
	});

	it("releases task when disabled", async () => {
		await act(async () => {
			root.render(<HookHarness taskId="task-a" projectId="project-1" sessionStartedAt={100} enabled />);
		});

		releaseTaskTerminalMock.mockClear();

		await act(async () => {
			root.render(<HookHarness taskId="task-a" projectId="project-1" sessionStartedAt={100} enabled={false} />);
		});

		expect(releaseTaskTerminalMock).toHaveBeenCalledTimes(1);
		expect(releaseTaskTerminalMock).toHaveBeenCalledWith("task-a");
	});

	it("does not remount when callback props change", async () => {
		const terminal = createTerminalSlotMock();
		acquireTaskTerminalMock.mockReturnValue(terminal);

		await act(async () => {
			root.render(
				<HookHarness
					taskId="task-a"
					projectId="project-1"
					sessionStartedAt={100}
					onSummary={() => {}}
					onConnectionReady={() => {}}
				/>,
			);
		});

		expect(terminal.show).toHaveBeenCalledTimes(1);
		expect(terminal.hide).not.toHaveBeenCalled();

		await act(async () => {
			root.render(
				<HookHarness
					taskId="task-a"
					projectId="project-1"
					sessionStartedAt={100}
					onSummary={() => {}}
					onConnectionReady={() => {}}
				/>,
			);
		});

		expect(terminal.show).toHaveBeenCalledTimes(1);
		expect(terminal.hide).not.toHaveBeenCalled();
	});

	it("restores authoritative content after resetting a restarted task session", async () => {
		const terminal = createTerminalSlotMock();
		acquireTaskTerminalMock.mockReturnValue(terminal);

		await act(async () => {
			root.render(<HookHarness taskId="task-a" projectId="project-1" sessionStartedAt={100} />);
		});

		terminal.reset.mockClear();
		terminal.requestRestore.mockClear();

		await act(async () => {
			root.render(<HookHarness taskId="task-a" projectId="project-1" sessionStartedAt={200} />);
		});

		expect(terminal.reset).toHaveBeenCalledTimes(1);
		expect(terminal.requestRestore).toHaveBeenCalledTimes(1);
	});

	it.each([false, true])(
		"does not expose manual restore through the terminal controller (enabled: %s)",
		async (enabled) => {
			await act(async () => {
				root.render(<HookHarness taskId="task-a" projectId="project-1" sessionStartedAt={100} enabled={enabled} />);
			});

			const controller = registerTerminalControllerMock.mock.calls.at(-1)?.[1];
			if (enabled) {
				expect(controller).toBeDefined();
				expect(controller).not.toHaveProperty("requestRestore");
			} else {
				expect(controller).toBeUndefined();
			}
		},
	);

	it("scopes controller registration to the exact project and session", async () => {
		await act(async () => {
			root.render(<HookHarness taskId="task-a" projectId="project-1" sessionStartedAt={100} />);
		});
		expect(registerTerminalControllerMock).toHaveBeenLastCalledWith(
			"task-a",
			expect.any(Object),
			{
				projectId: "project-1",
				sessionInstanceId: "session-1",
				sessionStartedAt: 100,
			},
			expect.any(Function),
		);
		await act(async () => {
			root.render(<HookHarness taskId="task-a" projectId="project-2" sessionStartedAt={100} />);
		});
		expect(registerTerminalControllerMock).toHaveBeenLastCalledWith(
			"task-a",
			expect.any(Object),
			{
				projectId: "project-2",
				sessionInstanceId: "session-1",
				sessionStartedAt: 100,
			},
			expect.any(Function),
		);
	});

	it("makes a captured controller inert after navigation rather than redirecting input", async () => {
		await act(async () => {
			root.render(<HookHarness taskId="task-a" projectId="project-1" sessionStartedAt={100} />);
		});
		const oldController = registerTerminalControllerMock.mock.calls.at(-1)?.[1];
		await act(async () => {
			root.render(<HookHarness taskId="task-a" projectId="project-2" sessionStartedAt={100} />);
		});
		expect(oldController.input("wrong project")).toBe(false);
		expect(oldController.paste("wrong project")).toBe(false);
		expect(await oldController.waitForLikelyPrompt(100)).toBe(false);
		const controller = registerTerminalControllerMock.mock.calls.at(-1)?.[1];
		expect(controller.input("not yet connected")).toBe(false);
		const subscriber = acquireTaskTerminalMock.mock.results.at(-1)?.value.subscribe.mock.calls.at(-1)?.[0];
		subscriber.onSummary(createTestTaskSessionSummary({ taskId: "task-a", sessionInstanceId: "session-1" }));
		subscriber.onConnectionReady("task-a");
		expect(controller.input("current project")).toBe(true);
	});

	it("does not mark a scoped controller ready until its transport summary matches the session", async () => {
		const terminal = createTerminalSlotMock();
		acquireTaskTerminalMock.mockReturnValue(terminal);
		await act(async () => root.render(<HookHarness taskId="task-a" projectId="project-1" sessionStartedAt={100} />));
		const controller = registerTerminalControllerMock.mock.calls.at(-1)?.[1];
		const subscriber = terminal.subscribe.mock.calls.at(-1)?.[0];
		subscriber?.onConnectionReady?.("task-a");
		subscriber?.onSummary?.(createTestTaskSessionSummary({ taskId: "task-a", sessionInstanceId: "old-session" }));
		expect(controller.input("wrong session")).toBe(false);
		subscriber?.onSummary?.(createTestTaskSessionSummary({ taskId: "task-a", sessionInstanceId: "session-1" }));
		expect(controller.input("current session")).toBe(true);
		subscriber?.onSummary?.(
			createTestTaskSessionSummary({ taskId: "task-a", sessionInstanceId: "replacement-session" }),
		);
		expect(controller.input("replaced session")).toBe(false);
	});

	it("uses dedicated terminal path for home shell", async () => {
		isDedicatedTerminalTaskIdMock.mockReturnValue(true);

		await act(async () => {
			root.render(<HookHarness taskId="__home_terminal__" projectId="project-1" sessionStartedAt={100} />);
		});

		expect(ensureDedicatedTerminalMock).toHaveBeenCalledTimes(1);
		expect(acquireTaskTerminalMock).not.toHaveBeenCalled();
	});

	it.each(["__home_terminal__", "__detail_terminal__:task-a"])(
		"releases the dedicated viewer on unmount without stopping its shell (%s)",
		async (taskId) => {
			isDedicatedTerminalTaskIdMock.mockReturnValue(true);
			const terminal = createTerminalSlotMock();
			ensureDedicatedTerminalMock.mockReturnValue(terminal);
			await act(async () => {
				root.render(<HookHarness taskId={taskId} projectId="project-1" sessionStartedAt={100} />);
			});
			await act(async () => root.render(null));
			expect(disposeDedicatedTerminalMock).toHaveBeenCalledExactlyOnceWith("project-1", taskId);
			expect(terminal.stop).not.toHaveBeenCalled();
			expect(terminal.park).not.toHaveBeenCalled();
			expect(releaseTaskTerminalMock).not.toHaveBeenCalled();

			await act(async () => {
				root.render(<HookHarness taskId={taskId} projectId="project-1" sessionStartedAt={100} />);
			});
			expect(ensureDedicatedTerminalMock).toHaveBeenCalledTimes(2);
			expect(terminal.reset).not.toHaveBeenCalled();
		},
	);

	it("does not create a shell viewer or controller when initially hidden", async () => {
		isDedicatedTerminalTaskIdMock.mockReturnValue(true);
		await act(async () => {
			root.render(
				<HookHarness taskId="__home_terminal__" projectId="project-1" sessionStartedAt={100} isVisible={false} />,
			);
		});
		expect(ensureDedicatedTerminalMock).not.toHaveBeenCalled();
		expect(registerTerminalControllerMock).not.toHaveBeenCalled();
	});

	it("disposes an invisible shell viewer and reacquires it only when visible", async () => {
		isDedicatedTerminalTaskIdMock.mockReturnValue(true);
		const terminal = createTerminalSlotMock();
		ensureDedicatedTerminalMock.mockReturnValue(terminal);
		await act(async () => {
			root.render(<HookHarness taskId="__home_terminal__" projectId="project-1" sessionStartedAt={100} />);
		});
		await act(async () => {
			root.render(
				<HookHarness taskId="__home_terminal__" projectId="project-1" sessionStartedAt={100} isVisible={false} />,
			);
		});
		expect(disposeDedicatedTerminalMock).toHaveBeenCalledExactlyOnceWith("project-1", "__home_terminal__");
		expect(ensureDedicatedTerminalMock).toHaveBeenCalledTimes(1);
		expect(terminal.stop).not.toHaveBeenCalled();
		await act(async () => {
			root.render(<HookHarness taskId="__home_terminal__" projectId="project-1" sessionStartedAt={100} />);
		});
		expect(ensureDedicatedTerminalMock).toHaveBeenCalledTimes(2);
	});

	it("releases the old shell's project and task on context changes", async () => {
		isDedicatedTerminalTaskIdMock.mockReturnValue(true);
		await act(async () => {
			root.render(<HookHarness taskId="__detail_terminal__:task-a" projectId="project-1" sessionStartedAt={100} />);
		});
		await act(async () => {
			root.render(<HookHarness taskId="__detail_terminal__:task-b" projectId="project-2" sessionStartedAt={100} />);
		});
		expect(disposeDedicatedTerminalMock).toHaveBeenCalledExactlyOnceWith("project-1", "__detail_terminal__:task-a");
		expect(ensureDedicatedTerminalMock).toHaveBeenLastCalledWith(
			expect.objectContaining({ projectId: "project-2", taskId: "__detail_terminal__:task-b" }),
		);
	});

	it("updates shell appearance without disposing or reacquiring its viewer", async () => {
		isDedicatedTerminalTaskIdMock.mockReturnValue(true);
		const terminal = createTerminalSlotMock();
		ensureDedicatedTerminalMock.mockReturnValue(terminal);
		await act(async () => {
			root.render(<HookHarness taskId="__home_terminal__" projectId="project-1" sessionStartedAt={100} />);
		});
		await act(async () => {
			root.render(
				<HookHarness
					taskId="__home_terminal__"
					projectId="project-1"
					sessionStartedAt={100}
					cursorColor="new-color"
				/>,
			);
		});
		expect(disposeDedicatedTerminalMock).not.toHaveBeenCalled();
		expect(ensureDedicatedTerminalMock).toHaveBeenCalledTimes(1);
		expect(terminal.show).toHaveBeenLastCalledWith(
			{ cursorColor: "new-color", terminalBackgroundColor: "terminal-background" },
			{ autoFocus: false, isVisible: true },
		);
	});

	it.each(["__home_terminal__", "__detail_terminal__:task-a"])(
		"keeps the shell viewer stable through startup and native replacement (%s)",
		async (taskId) => {
			isDedicatedTerminalTaskIdMock.mockReturnValue(true);
			const terminal = createTerminalSlotMock();
			ensureDedicatedTerminalMock.mockReturnValue(terminal);
			await act(async () => {
				root.render(<HookHarness taskId={taskId} projectId="project-1" sessionStartedAt={null} />);
			});
			await act(async () => terminal.subscribe.mock.calls[0]?.[0].onConnectionReady?.(taskId));
			for (const sessionStartedAt of [100, null, 200]) {
				await act(async () => {
					root.render(<HookHarness taskId={taskId} projectId="project-1" sessionStartedAt={sessionStartedAt} />);
				});
				expect(container.querySelector("output")?.textContent).toBe("ready");
			}
			// Transport replacement/restore belongs to the attachment controller,
			// not to a second React-driven viewer teardown and autofocus.
			expect(disposeDedicatedTerminalMock).not.toHaveBeenCalled();
			expect(ensureDedicatedTerminalMock).toHaveBeenCalledTimes(1);
			expect(terminal.show).toHaveBeenCalledTimes(1);
			expect(terminal.reset).not.toHaveBeenCalled();
			expect(terminal.stop).not.toHaveBeenCalled();
		},
	);

	it("balances dedicated viewer ownership through StrictMode and repeated repository navigation", async () => {
		isDedicatedTerminalTaskIdMock.mockReturnValue(true);
		await act(async () => {
			root.render(
				<StrictMode>
					<HookHarness taskId="__detail_terminal__:task-a" projectId="project-1" sessionStartedAt={100} />
				</StrictMode>,
			);
		});
		expect(ensureDedicatedTerminalMock).toHaveBeenCalledTimes(2);
		expect(disposeDedicatedTerminalMock).toHaveBeenCalledTimes(1);
		for (let cycle = 0; cycle < 3; cycle++) {
			await act(async () =>
				root.render(
					<StrictMode>
						<div>Files or Git</div>
					</StrictMode>,
				),
			);
			expect(disposeDedicatedTerminalMock).toHaveBeenCalledTimes(ensureDedicatedTerminalMock.mock.calls.length);
			await act(async () => {
				root.render(
					<StrictMode>
						<HookHarness taskId="__detail_terminal__:task-a" projectId="project-1" sessionStartedAt={100} />
					</StrictMode>,
				);
			});
			expect(ensureDedicatedTerminalMock.mock.calls.length - disposeDedicatedTerminalMock.mock.calls.length).toBe(1);
		}
	});

	it("disposes dedicated terminal when disabled", async () => {
		isDedicatedTerminalTaskIdMock.mockReturnValue(true);

		await act(async () => {
			root.render(<HookHarness taskId="__home_terminal__" projectId="project-1" sessionStartedAt={100} enabled />);
		});

		disposeDedicatedTerminalMock.mockClear();

		await act(async () => {
			root.render(
				<HookHarness taskId="__home_terminal__" projectId="project-1" sessionStartedAt={100} enabled={false} />,
			);
		});

		expect(disposeDedicatedTerminalMock).toHaveBeenCalledTimes(1);
		expect(disposeDedicatedTerminalMock).toHaveBeenCalledWith("project-1", "__home_terminal__");
		expect(releaseTaskTerminalMock).not.toHaveBeenCalled();
	});
});
