import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { RuntimeTaskSessionSummary } from "@/runtime/types";
import { usePersistentTerminalSession } from "@/terminal/use-persistent-terminal-session";

const acquireForTaskMock = vi.hoisted(() => vi.fn());
const attachPoolContainerMock = vi.hoisted(() => vi.fn());
const releaseTaskMock = vi.hoisted(() => vi.fn());
const isDedicatedTerminalTaskIdMock = vi.hoisted(() => vi.fn());
const ensureDedicatedTerminalMock = vi.hoisted(() => vi.fn());
const disposeDedicatedTerminalMock = vi.hoisted(() => vi.fn());
const registerTerminalControllerMock = vi.hoisted(() => vi.fn());

vi.mock("@/terminal/terminal-pool", () => ({
	acquireForTask: acquireForTaskMock,
	attachPoolContainer: attachPoolContainerMock,
	releaseTask: releaseTaskMock,
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
		input: vi.fn(() => true),
		paste: vi.fn(() => true),
		waitForLikelyPrompt: vi.fn(async () => true),
		clear: vi.fn(),
		stop: vi.fn(async () => {}),
	};
}

function HookHarness({
	taskId,
	workspaceId,
	sessionStartedAt,
	enabled = true,
	onSummary,
	onConnectionReady,
}: {
	taskId: string;
	workspaceId: string | null;
	sessionStartedAt: number | null;
	enabled?: boolean;
	onSummary?: (summary: RuntimeTaskSessionSummary) => void;
	onConnectionReady?: (taskId: string) => void;
}) {
	const { containerRef } = usePersistentTerminalSession({
		taskId,
		workspaceId,
		enabled,
		onSummary,
		onConnectionReady,
		sessionStartedAt,
		terminalBackgroundColor: "terminal-background",
		cursorColor: "cursor-color",
	});

	return <div ref={containerRef} />;
}

describe("usePersistentTerminalSession", () => {
	let container: HTMLDivElement;
	let root: Root;
	let previousActEnvironment: boolean | undefined;

	beforeEach(() => {
		acquireForTaskMock.mockReset();
		attachPoolContainerMock.mockReset();
		releaseTaskMock.mockReset();
		isDedicatedTerminalTaskIdMock.mockReset();
		ensureDedicatedTerminalMock.mockReset();
		disposeDedicatedTerminalMock.mockReset();
		registerTerminalControllerMock.mockReset();
		registerTerminalControllerMock.mockReturnValue(() => {});
		// Default: regular task IDs go through pool path
		isDedicatedTerminalTaskIdMock.mockReturnValue(false);
		acquireForTaskMock.mockImplementation(() => createTerminalSlotMock());
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
			root.render(<HookHarness taskId="task-a" workspaceId="project-1" sessionStartedAt={100} />);
		});

		expect(acquireForTaskMock).toHaveBeenCalledTimes(1);
		expect(acquireForTaskMock).toHaveBeenCalledWith("task-a", "project-1");
	});

	it("shows slot into container", async () => {
		const terminal = createTerminalSlotMock();
		acquireForTaskMock.mockReturnValue(terminal);

		await act(async () => {
			root.render(<HookHarness taskId="task-a" workspaceId="project-1" sessionStartedAt={100} />);
		});

		expect(terminal.show).toHaveBeenCalledTimes(1);
	});

	it("does not dispose slot on task switch (pool manages lifecycle)", async () => {
		await act(async () => {
			root.render(<HookHarness taskId="task-a" workspaceId="project-1" sessionStartedAt={100} />);
		});

		await act(async () => {
			root.render(<HookHarness taskId="task-b" workspaceId="project-1" sessionStartedAt={200} />);
		});

		expect(releaseTaskMock).not.toHaveBeenCalled();
		expect(acquireForTaskMock).toHaveBeenCalledTimes(2);
	});

	it("releases task when disabled", async () => {
		await act(async () => {
			root.render(<HookHarness taskId="task-a" workspaceId="project-1" sessionStartedAt={100} enabled />);
		});

		releaseTaskMock.mockClear();

		await act(async () => {
			root.render(<HookHarness taskId="task-a" workspaceId="project-1" sessionStartedAt={100} enabled={false} />);
		});

		expect(releaseTaskMock).toHaveBeenCalledTimes(1);
		expect(releaseTaskMock).toHaveBeenCalledWith("task-a");
	});

	it("does not remount when callback props change", async () => {
		const terminal = createTerminalSlotMock();
		acquireForTaskMock.mockReturnValue(terminal);

		await act(async () => {
			root.render(
				<HookHarness
					taskId="task-a"
					workspaceId="project-1"
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
					workspaceId="project-1"
					sessionStartedAt={100}
					onSummary={() => {}}
					onConnectionReady={() => {}}
				/>,
			);
		});

		expect(terminal.show).toHaveBeenCalledTimes(1);
		expect(terminal.hide).not.toHaveBeenCalled();
	});

	it("uses dedicated terminal path for home shell", async () => {
		isDedicatedTerminalTaskIdMock.mockReturnValue(true);

		await act(async () => {
			root.render(<HookHarness taskId="__home_terminal__" workspaceId="project-1" sessionStartedAt={100} />);
		});

		expect(ensureDedicatedTerminalMock).toHaveBeenCalledTimes(1);
		expect(acquireForTaskMock).not.toHaveBeenCalled();
	});

	it("disposes dedicated terminal when disabled", async () => {
		isDedicatedTerminalTaskIdMock.mockReturnValue(true);

		await act(async () => {
			root.render(<HookHarness taskId="__home_terminal__" workspaceId="project-1" sessionStartedAt={100} enabled />);
		});

		disposeDedicatedTerminalMock.mockClear();

		await act(async () => {
			root.render(
				<HookHarness taskId="__home_terminal__" workspaceId="project-1" sessionStartedAt={100} enabled={false} />,
			);
		});

		expect(disposeDedicatedTerminalMock).toHaveBeenCalledTimes(1);
		expect(disposeDedicatedTerminalMock).toHaveBeenCalledWith("project-1", "__home_terminal__");
		expect(releaseTaskMock).not.toHaveBeenCalled();
	});
});
