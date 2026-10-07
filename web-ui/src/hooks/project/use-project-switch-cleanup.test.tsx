import { act, useEffect, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type UseTaskEditorResult, useTaskEditor } from "@/hooks/board/use-task-editor";
import { getProjectMetadataScopeVersion } from "@/stores/project-metadata-store";
import type { BoardData } from "@/types";
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
	function Harness({
		path,
		unavailable = false,
		projectId = "project-a",
		navigationProjectId = projectId,
		switching = false,
	}: {
		path: string | null;
		unavailable?: boolean;
		projectId?: string | null;
		navigationProjectId?: string | null;
		switching?: boolean;
	}) {
		useProjectSwitchCleanup({
			currentProjectId: projectId,
			navigationCurrentProjectId: navigationProjectId,
			isProjectSwitching: switching,
			projectPath: path,
			isProjectUnavailable: unavailable,
			...callbacks,
			// Callback identity can change when the editor's defaults hydrate.
			resetTaskEditorWorkflow: () => callbacks.resetTaskEditorWorkflow(),
		});
		return null;
	}
	function TaskEditorHarness({
		path,
		projectId = "project-a",
		onEditor,
	}: {
		path: string | null;
		projectId?: string;
		onEditor: (editor: UseTaskEditorResult) => void;
	}) {
		const [board, setBoard] = useState<BoardData>({ columns: [] });
		const [, setSelectedTaskId] = useState<string | null>(null);
		const editor = useTaskEditor({
			board,
			setBoard,
			currentProjectId: projectId,
			createTaskBranchOptions: [{ value: "main", label: "main" }],
			defaultTaskBranchRef: "main",
			fallbackTaskAgentId: "claude",
			setSelectedTaskId,
		});
		useProjectSwitchCleanup({
			...callbacks,
			currentProjectId: projectId,
			navigationCurrentProjectId: projectId,
			isProjectSwitching: false,
			projectPath: path,
			resetTaskEditorWorkflow: editor.resetTaskEditorState,
		});
		useEffect(() => onEditor(editor));
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
	it("preserves an opened task draft while the same project's initial path hydrates", async () => {
		let editor: UseTaskEditorResult | null = null;
		const onEditor = (value: UseTaskEditorResult) => {
			editor = value;
		};
		const currentEditor = () => {
			if (!editor) throw new Error("Expected the task editor to be mounted.");
			return editor;
		};
		await act(async () => root.render(<TaskEditorHarness path={null} onEditor={onEditor} />));
		await act(async () => currentEditor().handleOpenCreateTask());
		await act(async () => currentEditor().setNewTaskPrompt("Keep my draft during metadata hydration"));
		vi.clearAllMocks();
		await act(async () => root.render(<TaskEditorHarness path="/hydrated" onEditor={onEditor} />));
		expect(currentEditor().isInlineTaskCreateOpen).toBe(true);
		expect(currentEditor().newTaskPrompt).toBe("Keep my draft during metadata hydration");
		expect(callbacks.resetGitActionState).not.toHaveBeenCalled();
		expect(terminals.releaseAll).not.toHaveBeenCalled();
		await act(async () => root.render(<TaskEditorHarness path="/other" projectId="project-b" onEditor={onEditor} />));
		expect(currentEditor().isInlineTaskCreateOpen).toBe(false);
		expect(callbacks.resetGitActionState).toHaveBeenCalledOnce();
	});
	it("resets once on initial mount but ignores same-scope callback identity changes", async () => {
		await act(async () => root.render(<Harness path={null} />));
		expect(callbacks.resetTaskEditorWorkflow).toHaveBeenCalledOnce();
		vi.clearAllMocks();
		await act(async () => root.render(<Harness path={null} />));
		await act(async () => root.render(<Harness path="/hydrated" />));
		await act(async () => root.render(<Harness path="/hydrated" />));
		expect(callbacks.resetTaskEditorWorkflow).not.toHaveBeenCalled();
		expect(callbacks.setIsClearTrashDialogOpen).not.toHaveBeenCalled();
		expect(callbacks.resetTerminalPanelsState).not.toHaveBeenCalled();
	});
	it("resets actual project changes even if their paths are both unresolved", async () => {
		await act(async () => root.render(<Harness path={null} />));
		vi.clearAllMocks();
		await act(async () => root.render(<Harness path={null} projectId="project-b" />));
		expect(callbacks.resetTaskEditorWorkflow).toHaveBeenCalledOnce();
		expect(terminals.disposeAllDedicatedTerminalsForProject).toHaveBeenCalledWith("project-a");
	});
	it("resets an established path being cleared, without treating its later hydration as another switch", async () => {
		await act(async () => root.render(<Harness path="/old" />));
		vi.clearAllMocks();
		await act(async () => root.render(<Harness path={null} />));
		expect(callbacks.resetTaskEditorWorkflow).toHaveBeenCalledOnce();
		expect(terminals.disposeAllDedicatedTerminalsForProject).toHaveBeenCalledWith("project-a");
		vi.clearAllMocks();
		await act(async () => root.render(<Harness path="/resolved" />));
		expect(callbacks.resetTaskEditorWorkflow).not.toHaveBeenCalled();
	});
	it.each([true, false])("resets an availability transition to unavailable=%s", async (unavailable) => {
		await act(async () => root.render(<Harness path="/path" unavailable={!unavailable} />));
		vi.clearAllMocks();
		await act(async () => root.render(<Harness path="/path" unavailable={unavailable} />));
		expect(callbacks.resetTaskEditorWorkflow).toHaveBeenCalledOnce();
		expect(callbacks.resetTerminalPanelsState).toHaveBeenCalledOnce();
	});
	it("resets the task editor on switching entry but not callback churn during the same switch", async () => {
		await act(async () => root.render(<Harness path="/path" />));
		vi.clearAllMocks();
		await act(async () => root.render(<Harness path="/path" switching />));
		expect(callbacks.resetTaskEditorWorkflow).toHaveBeenCalledOnce();
		vi.clearAllMocks();
		await act(async () => root.render(<Harness path="/path" switching />));
		expect(callbacks.resetTaskEditorWorkflow).not.toHaveBeenCalled();
		await act(async () => root.render(<Harness path="/path" />));
		await act(async () => root.render(<Harness path="/path" switching />));
		expect(callbacks.resetTaskEditorWorkflow).toHaveBeenCalledOnce();
	});
	it("scopes project metadata before running the target project's transient reset", async () => {
		await act(async () => root.render(<Harness path="/path" />));
		callbacks.resetGitActionState.mockImplementationOnce(() => {
			expect(getProjectMetadataScopeVersion("project-b")).not.toBe(-1);
			expect(getProjectMetadataScopeVersion("project-a")).toBe(-1);
		});
		await act(async () => root.render(<Harness path="/other" projectId="project-b" />));
	});
	it("resets a new navigation target during an active switch without resetting on callback churn", async () => {
		await act(async () => root.render(<Harness path="/path" switching navigationProjectId="project-b" />));
		vi.clearAllMocks();
		await act(async () => root.render(<Harness path="/path" switching navigationProjectId="project-c" />));
		expect(callbacks.resetTaskEditorWorkflow).toHaveBeenCalledOnce();
		expect(callbacks.resetProjectSyncState).toHaveBeenCalledWith("project-c");
		expect(getProjectMetadataScopeVersion("project-c")).not.toBe(-1);
		vi.clearAllMocks();
		await act(async () => root.render(<Harness path="/path" switching navigationProjectId="project-c" />));
		expect(callbacks.resetTaskEditorWorkflow).not.toHaveBeenCalled();
	});
});
