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

	it("does not register the retired bulk-start shortcut", async () => {
		await act(async () => {
			root.render(
				<HookHarness
					selectedCard={null}
					canUseCreateTaskShortcut
					handleToggleDetailTerminal={() => {}}
					handleToggleHomeTerminal={() => {}}
					handleOpenCreateTask={() => {}}
					handleOpenSettings={() => {}}
					currentProjectId="test-project"
					handleToggleFileFinder={() => {}}
					handleToggleTextSearch={() => {}}
				/>,
			);
		});

		expect(mockUseHotkeys.mock.calls.some(([shortcut]) => shortcut === "mod+b")).toBe(false);
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

	it.each(["unavailable", "offline", "onboarding"])(
		"blocks project keyboard actions while %s and keeps settings accessible",
		async (reason) => {
			const projectAction = vi.fn();
			const settingsAction = vi.fn();
			await act(async () =>
				root.render(
					<HookHarness
						selectedCard={null}
						canUseCreateTaskShortcut
						canUseProjectActions={reason !== "unavailable"}
						runtimeConnected={reason !== "offline"}
						onboarding={reason === "onboarding"}
						currentProjectId="unavailable-project"
						handleToggleDetailTerminal={projectAction}
						handleToggleHomeTerminal={projectAction}
						handleOpenCreateTask={projectAction}
						handleToggleFileFinder={projectAction}
						handleToggleTextSearch={projectAction}
						handleOpenSettings={settingsAction}
					/>,
				),
			);
			act(() => {
				for (const shortcut of ["c", "mod+j", "mod+p", "mod+shift+f", "mod+shift+s"]) {
					const handler = mockUseHotkeys.mock.calls.find(([key]) => key === shortcut)?.[1];
					if (typeof handler !== "function") throw new Error(`Missing shortcut ${shortcut}`);
					(handler as () => void)();
				}
			});
			expect(projectAction).not.toHaveBeenCalled();
			expect(settingsAction).toHaveBeenCalledTimes(1);
		},
	);
});
