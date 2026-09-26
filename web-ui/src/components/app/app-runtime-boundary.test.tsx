import { act, useEffect, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { AppRuntimeBoundary } from "@/components/app/app-runtime-boundary";
import { type UseTaskEditorResult, useTaskEditor } from "@/hooks/board/use-task-editor";
import type { BoardData, TaskImage } from "@/types";

const connection = vi.hoisted(() => ({ isRuntimeDisconnected: false, streamError: null as string | null }));
const runtime = vi.hoisted(() => ({ isQuarterdeckAccessBlocked: false }));
vi.mock("@/providers/project-provider", () => ({ useProjectRuntimeStreamContext: () => connection }));
vi.mock("@/providers/project-runtime-provider", () => ({ useProjectRuntimeContext: () => runtime }));

describe("AppRuntimeBoundary", () => {
	let root: Root;
	let container: HTMLDivElement;
	let editor: UseTaskEditorResult;
	const unmount = vi.fn();
	const showModal = vi.fn();
	const close = vi.fn();

	function Editor(): React.ReactNode {
		const [board, setBoard] = useState<BoardData>({ columns: [], dependencies: [] });
		const [, setSelectedTaskId] = useState<string | null>(null);
		editor = useTaskEditor({
			board,
			setBoard,
			setSelectedTaskId,
			currentProjectId: "project-1",
			createTaskBranchOptions: [{ value: "main", label: "main" }],
			defaultTaskBranchRef: "main",
			fallbackTaskAgentId: "codex",
		});
		useEffect(() => unmount, []);
		return <textarea aria-label="Draft prompt" defaultValue="Local editor state" />;
	}

	function render(): void {
		act(() =>
			root.render(
				<AppRuntimeBoundary>
					<Editor />
				</AppRuntimeBoundary>,
			),
		);
	}

	beforeEach(() => {
		vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
		Object.defineProperty(HTMLDialogElement.prototype, "showModal", { configurable: true, value: showModal });
		Object.defineProperty(HTMLDialogElement.prototype, "close", { configurable: true, value: close });
		connection.isRuntimeDisconnected = false;
		connection.streamError = null;
		runtime.isQuarterdeckAccessBlocked = false;
		container = document.createElement("div");
		document.body.appendChild(container);
		root = createRoot(container);
	});

	afterEach(() => {
		act(() => root.unmount());
		container.remove();
		Reflect.deleteProperty(HTMLDialogElement.prototype, "showModal");
		Reflect.deleteProperty(HTMLDialogElement.prototype, "close");
		vi.unstubAllGlobals();
		vi.clearAllMocks();
	});

	it("preserves draft prompts, images, and editor DOM through repeated disconnects", () => {
		render();
		const input = container.querySelector("textarea");
		const images: TaskImage[] = [{ id: "image-1", name: "draft.png", data: "YQ==", mimeType: "image/png" }];
		act(() => {
			editor.handleOpenCreateTask();
			editor.setNewTaskPrompt("Unsaved prompt");
			editor.setNewTaskImages(images);
			editor.setEditTaskPrompt("Unsaved edit");
			editor.setEditTaskImages(images);
		});
		for (const disconnected of [true, false, true, false]) {
			connection.isRuntimeDisconnected = disconnected;
			connection.streamError = disconnected ? "Connection lost" : null;
			render();
			expect(document.querySelector("dialog") !== null).toBe(disconnected);
			expect(container.querySelector("textarea")).toBe(input);
			expect(editor.newTaskPrompt).toBe("Unsaved prompt");
			expect(editor.newTaskImages).toEqual(images);
			expect(editor.editTaskPrompt).toBe("Unsaved edit");
			expect(editor.editTaskImages).toEqual(images);
			expect(editor.isInlineTaskCreateOpen).toBe(true);
			expect(unmount).not.toHaveBeenCalled();
		}
		expect(showModal).toHaveBeenCalledTimes(2);
		expect(close).toHaveBeenCalledTimes(2);
	});

	it("blocks background shortcuts and dismissal until reconnected", () => {
		const shortcut = vi.fn();
		const outsidePointerDown = vi.fn();
		document.addEventListener("keydown", shortcut, true);
		document.addEventListener("pointerdown", outsidePointerDown);
		try {
			// Radix hides the app root while a task dialog is open.
			container.setAttribute("aria-hidden", "true");
			connection.isRuntimeDisconnected = true;
			connection.streamError = "Connection lost";
			render();
			expect(document.body.textContent).toContain("Connection lost");
			const dialog = document.querySelector("dialog");
			expect(dialog?.closest('[aria-hidden="true"]')).toBeNull();
			dialog?.dispatchEvent(new Event("pointerdown", { bubbles: true }));
			expect(outsidePointerDown).not.toHaveBeenCalled();
			dialog?.dispatchEvent(new KeyboardEvent("keydown", { key: "b", metaKey: true, bubbles: true }));
			expect(shortcut).not.toHaveBeenCalled();
			const cancel = new Event("cancel", { cancelable: true });
			dialog?.dispatchEvent(cancel);
			expect(cancel.defaultPrevented).toBe(true);
			connection.isRuntimeDisconnected = false;
			render();
			document.dispatchEvent(new KeyboardEvent("keydown", { key: "b", bubbles: true }));
			expect(shortcut).toHaveBeenCalledTimes(1);
		} finally {
			document.removeEventListener("keydown", shortcut, true);
			document.removeEventListener("pointerdown", outsidePointerDown);
		}
	});

	it("still gates organizational access", () => {
		runtime.isQuarterdeckAccessBlocked = true;
		render();
		expect(container.querySelector("textarea")).toBeNull();
		expect(container.textContent).toContain("Quarterdeck is not enabled for your organization");
	});
});
