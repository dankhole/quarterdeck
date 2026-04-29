import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { RuntimeTaskSessionSummary } from "@/runtime/types";
import { usePersistentTerminalSession } from "@/terminal/use-persistent-terminal-session";

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
		subscribe: vi.fn(() => vi.fn()),
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
	onSummary,
	onConnectionReady,
}: {
	taskId: string;
	projectId: string | null;
	sessionStartedAt: number | null;
	enabled?: boolean;
	onSummary?: (summary: RuntimeTaskSessionSummary) => void;
	onConnectionReady?: (taskId: string) => void;
}) {
	const { containerRef, requestRestore } = usePersistentTerminalSession({
		taskId,
		projectId,
		enabled,
		onSummary,
		onConnectionReady,
		sessionStartedAt,
		terminalBackgroundColor: "terminal-background",
		cursorColor: "cursor-color",
	});

	return (
		<>
			<div ref={containerRef} />
			<button type="button" onClick={requestRestore}>
				Request restore
			</button>
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
		registerTerminalControllerMock.mockReturnValue(() => {});
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

	it("acquires slot from pool on mount", async () => {
		await act(async () => {
			root.render(<HookHarness taskId="task-a" projectId="project-1" sessionStartedAt={100} />);
		});

		expect(acquireTaskTerminalMock).toHaveBeenCalledTimes(1);
		expect(acquireTaskTerminalMock).toHaveBeenCalledWith("task-a", "project-1");
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

	it("resets without requesting another restore for a restarted task session", async () => {
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
		expect(terminal.requestRestore).not.toHaveBeenCalled();
	});

	it("requests a fresh restore on the mounted terminal", async () => {
		const terminal = createTerminalSlotMock();
		acquireTaskTerminalMock.mockReturnValue(terminal);

		await act(async () => {
			root.render(<HookHarness taskId="task-a" projectId="project-1" sessionStartedAt={100} />);
		});

		await act(async () => {
			container.querySelector("button")?.click();
		});

		expect(terminal.requestRestore).toHaveBeenCalledTimes(1);
	});

	it("registers terminal restore on the shared terminal controller", async () => {
		const terminal = createTerminalSlotMock();
		acquireTaskTerminalMock.mockReturnValue(terminal);

		await act(async () => {
			root.render(<HookHarness taskId="task-a" projectId="project-1" sessionStartedAt={100} />);
		});

		const controller = registerTerminalControllerMock.mock.calls.at(-1)?.[1];
		expect(controller.requestRestore()).toBe(true);

		expect(terminal.requestRestore).toHaveBeenCalledTimes(1);
	});

	it("reports failed restore when no terminal is mounted", async () => {
		await act(async () => {
			root.render(<HookHarness taskId="task-a" projectId="project-1" sessionStartedAt={100} enabled={false} />);
		});

		const controller = registerTerminalControllerMock.mock.calls.at(-1)?.[1];

		expect(controller.requestRestore()).toBe(false);
		expect(acquireTaskTerminalMock).not.toHaveBeenCalled();
	});

	it("uses dedicated terminal path for home shell", async () => {
		isDedicatedTerminalTaskIdMock.mockReturnValue(true);

		await act(async () => {
			root.render(<HookHarness taskId="__home_terminal__" projectId="project-1" sessionStartedAt={100} />);
		});

		expect(ensureDedicatedTerminalMock).toHaveBeenCalledTimes(1);
		expect(acquireTaskTerminalMock).not.toHaveBeenCalled();
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
