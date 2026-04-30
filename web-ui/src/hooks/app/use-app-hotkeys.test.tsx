import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { useHotkeys } from "react-hotkeys-hook";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { useAppHotkeys } from "@/hooks/app/use-app-hotkeys";

vi.mock("react-hotkeys-hook", () => ({
	useHotkeys: vi.fn(),
}));

const mockUseHotkeys = vi.mocked(useHotkeys);

function HookHarness(props: Parameters<typeof useAppHotkeys>[0]): null {
	useAppHotkeys(props);
	return null;
}

describe("useAppHotkeys", () => {
	let container: HTMLDivElement;
	let root: Root;
	let previousActEnvironment: boolean | undefined;

	beforeEach(() => {
		previousActEnvironment = (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean })
			.IS_REACT_ACT_ENVIRONMENT;
		(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
		container = document.createElement("div");
		document.body.appendChild(container);
		root = createRoot(container);
		mockUseHotkeys.mockReset();
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

	it("registers settings shortcut and leaves removed view shortcuts unbound", async () => {
		const handleOpenSettings = vi.fn();

		await act(async () => {
			root.render(
				<HookHarness
					selectedCard={null}
					canUseCreateTaskShortcut
					handleToggleDetailTerminal={() => {}}
					handleToggleHomeTerminal={() => {}}
					handleOpenCreateTask={() => {}}
					handleOpenSettings={handleOpenSettings}
					onStartAllTasks={() => {}}
					currentProjectId="test-project"
					handleToggleFileFinder={() => {}}
					handleToggleTextSearch={() => {}}
				/>,
			);
		});

		const gitHistoryCall = mockUseHotkeys.mock.calls.find(([shortcut]) => shortcut === "mod+g");
		const expandTerminalCall = mockUseHotkeys.mock.calls.find(([shortcut]) => shortcut === "mod+m");
		const settingsCall = mockUseHotkeys.mock.calls.find(([shortcut]) => shortcut === "mod+shift+s");
		if (!settingsCall || typeof settingsCall[1] !== "function") {
			throw new Error("Expected settings shortcut to be registered.");
		}

		act(() => {
			const settingsHandler = settingsCall[1] as () => void;
			settingsHandler();
		});

		expect(gitHistoryCall).toBeUndefined();
		expect(expandTerminalCall).toBeUndefined();
		expect(handleOpenSettings).toHaveBeenCalledTimes(1);
	});

	it("starts all tasks on Mod+B", async () => {
		const onStartAllTasks = vi.fn();

		await act(async () => {
			root.render(
				<HookHarness
					selectedCard={null}
					canUseCreateTaskShortcut
					handleToggleDetailTerminal={() => {}}
					handleToggleHomeTerminal={() => {}}
					handleOpenCreateTask={() => {}}
					handleOpenSettings={() => {}}
					onStartAllTasks={onStartAllTasks}
					currentProjectId="test-project"
					handleToggleFileFinder={() => {}}
					handleToggleTextSearch={() => {}}
				/>,
			);
		});

		const startAllTasksCall = mockUseHotkeys.mock.calls.find(([shortcut]) => shortcut === "mod+b");
		if (!startAllTasksCall || typeof startAllTasksCall[1] !== "function") {
			throw new Error("Expected start all tasks shortcut to be registered.");
		}

		act(() => {
			const startAllTasksHandler = startAllTasksCall[1] as () => void;
			startAllTasksHandler();
		});

		expect(onStartAllTasks).toHaveBeenCalledTimes(1);
	});

	it("does not open create task on C when create-task shortcut is disabled", async () => {
		const handleOpenCreateTask = vi.fn();

		await act(async () => {
			root.render(
				<HookHarness
					selectedCard={null}
					canUseCreateTaskShortcut={false}
					handleToggleDetailTerminal={() => {}}
					handleToggleHomeTerminal={() => {}}
					handleOpenCreateTask={handleOpenCreateTask}
					handleOpenSettings={() => {}}
					onStartAllTasks={() => {}}
					currentProjectId="test-project"
					handleToggleFileFinder={() => {}}
					handleToggleTextSearch={() => {}}
				/>,
			);
		});

		const createTaskCall = mockUseHotkeys.mock.calls.find(([shortcut]) => shortcut === "c");
		if (!createTaskCall || typeof createTaskCall[1] !== "function") {
			throw new Error("Expected create task shortcut to be registered.");
		}

		act(() => {
			const createTaskHandler = createTaskCall[1] as () => void;
			createTaskHandler();
		});

		expect(handleOpenCreateTask).not.toHaveBeenCalled();
	});
});
