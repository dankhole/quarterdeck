import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useProjectSwitchCleanup } from "./use-project-switch-cleanup";

const terminals = vi.hoisted(() => ({ releaseAll: vi.fn(), disposeAllDedicatedTerminalsForProject: vi.fn() }));
vi.mock("@/terminal/terminal-pool", () => terminals);

describe("same-project location cleanup", () => {
	let root: Root;
	let container: HTMLDivElement;
	let previousActEnvironment: boolean | undefined;
	const callbacks = {
		resetTaskEditorWorkflow: vi.fn(),
		setIsClearTrashDialogOpen: vi.fn(),
		resetGitActionState: vi.fn(),
		resetProjectNavigationState: vi.fn(),
		resetTerminalPanelsState: vi.fn(),
		resetProjectSyncState: vi.fn(),
	};
	function Harness({ path, unavailable = false }: { path: string; unavailable?: boolean }) {
		useProjectSwitchCleanup({
			currentProjectId: "project-a",
			navigationCurrentProjectId: "project-a",
			isProjectSwitching: false,
			projectPath: path,
			isProjectUnavailable: unavailable,
			...callbacks,
		});
		return null;
	}

	beforeEach(() => {
		previousActEnvironment = (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean })
			.IS_REACT_ACT_ENVIRONMENT;
		(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
		container = document.createElement("div");
		root = createRoot(container);
		vi.clearAllMocks();
	});
	afterEach(() => {
		act(() => root.unmount());
		(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
			previousActEnvironment;
	});

	it("disposes old terminals and resets transient views without resetting the saved board", async () => {
		await act(async () => root.render(<Harness path="/old" />));
		vi.clearAllMocks();
		await act(async () => root.render(<Harness path="/new" />));
		expect(terminals.releaseAll).toHaveBeenCalledOnce();
		expect(terminals.disposeAllDedicatedTerminalsForProject).toHaveBeenCalledWith("project-a");
		expect(callbacks.resetGitActionState).toHaveBeenCalledOnce();
		expect(callbacks.resetTerminalPanelsState).toHaveBeenCalledOnce();
		expect(callbacks.resetProjectNavigationState).toHaveBeenCalledOnce();
		expect(callbacks.resetProjectSyncState).not.toHaveBeenCalled();
		vi.clearAllMocks();
		await act(async () => root.render(<Harness path="/new" unavailable />));
		expect(terminals.disposeAllDedicatedTerminalsForProject).toHaveBeenCalledWith("project-a");
		expect(callbacks.resetProjectSyncState).not.toHaveBeenCalled();
	});
});
