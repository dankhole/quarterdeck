import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	clearCachedFileEditorTabs,
	getCachedFileEditorTabs,
	getFileEditorDrafts,
	registerFileEditorScope,
	retireFileEditorScopes,
	setCachedFileEditorTabs,
} from "@/hooks/git/file-editor-cache";
import { createFileEditorTab } from "@/hooks/git/file-editor-workspace";
import type { RuntimeProjectSummary } from "@/runtime/types";
import { type UseProjectManagementResult, useProjectManagement } from "./use-project-management";

const api = vi.hoisted(() => ({
	rename: vi.fn(),
	locate: vi.fn(),
	renameFolder: vi.fn(),
	pickDirectory: vi.fn(),
	checkAvailability: vi.fn(),
}));
vi.mock("@/runtime/trpc-client", () => ({
	getRuntimeTrpcClient: () => ({
		projects: Object.fromEntries(Object.entries(api).map(([name, mutate]) => [name, { mutate }])),
	}),
}));
vi.mock("@/components/app-toaster", () => ({ notifyError: vi.fn(), showAppToast: vi.fn() }));

const project: RuntimeProjectSummary = {
	id: "p1",
	name: "project",
	path: "/projects/project",
	boardRevision: 3,
	taskCounts: { in_progress: 0, review: 2, trash: 0 },
};

describe("project management", () => {
	let root: Root;
	let container: HTMLDivElement;
	let management: UseProjectManagementResult;
	const applyResult = vi.fn();
	const flushBoardCommands = vi.fn();

	function Harness({
		currentProjectId = "p1",
		projects = [project],
	}: {
		currentProjectId?: string;
		projects?: RuntimeProjectSummary[];
	}) {
		management = useProjectManagement({
			currentProjectId,
			projects,
			isRuntimeDisconnected: false,
			flushBoardCommands,
			applyResult,
		});
		return null;
	}
	function render(currentProjectId = "p1", projects = [project]) {
		act(() => root.render(<Harness currentProjectId={currentProjectId} projects={projects} />));
	}
	function cacheFile(value: string, isSaving = false) {
		registerFileEditorScope("home", { projectId: "p1", taskId: null, rootPath: project.path });
		const tab = createFileEditorTab("app.ts", {
			content: "saved",
			contentHash: "hash",
			language: "typescript",
			binary: false,
			truncated: false,
			size: 5,
		});
		setCachedFileEditorTabs("home", [{ ...tab, value, isSaving }]);
	}

	beforeEach(() => {
		container = document.createElement("div");
		root = createRoot(container);
		vi.clearAllMocks();
		flushBoardCommands.mockResolvedValue({ ok: true });
		for (const mutation of Object.values(api)) mutation.mockResolvedValue({ ok: true, project });
		render();
	});
	afterEach(() => {
		act(() => root.unmount());
		clearCachedFileEditorTabs();
	});

	it("renames and clears the display name without changing editor scopes or flushing task commands", async () => {
		cacheFile("draft");
		act(() => management.requestRename("p1"));
		act(() => management.setValue("  Team portal  "));
		await act(async () => management.confirm());
		expect(api.rename).toHaveBeenCalledWith({ projectId: "p1", name: "Team portal" });
		expect(flushBoardCommands).not.toHaveBeenCalled();
		expect(getFileEditorDrafts()[0]?.tab.value).toBe("draft");
		expect(management.dialog).toBeNull();
		act(() => management.requestRename("p1"));
		act(() => management.setValue(""));
		await act(async () => management.confirm());
		expect(api.rename).toHaveBeenLastCalledWith({ projectId: "p1", name: null });
	});

	it("captures the original project and expected path across navigation and server summary changes", async () => {
		act(() => management.requestLocate("p1"));
		act(() => management.setValue(" /projects/renamed "));
		render("p2", [
			{ ...project, path: "/somewhere/else" },
			{ ...project, id: "p2" },
		]);
		await act(async () => management.confirm());
		expect(api.locate).toHaveBeenCalledWith({
			projectId: "p1",
			expectedPath: project.path,
			path: "/projects/renamed",
		});
		expect(flushBoardCommands).not.toHaveBeenCalled();
		expect(applyResult).toHaveBeenCalledWith(project, undefined);
	});

	it("checks dirty buffers after the board flush and keeps them when relocation is blocked", async () => {
		let finishFlush: ((value: { ok: boolean }) => void) | undefined;
		flushBoardCommands.mockImplementation(
			() =>
				new Promise<{ ok: boolean }>((resolve) => {
					finishFlush = resolve;
				}),
		);
		act(() => management.requestRenameFolder("p1"));
		act(() => management.setValue("renamed"));
		let saving: Promise<void> | undefined;
		act(() => {
			saving = management.confirm();
		});
		cacheFile("unsaved while flushing");
		await act(async () => {
			finishFlush?.({ ok: true });
			await saving;
		});
		expect(api.renameFolder).not.toHaveBeenCalled();
		expect(management.error).toContain("Save or discard");
		expect(getFileEditorDrafts()[0]?.tab.value).toBe("unsaved while flushing");
		expect(management.dialog?.value).toBe("renamed");
	});

	it("keeps clean scopes on failure and retires them only after a successful folder rename", async () => {
		cacheFile("saved");
		act(() => management.requestRenameFolder("p1"));
		act(() => management.setValue("renamed"));
		api.renameFolder.mockResolvedValueOnce({ ok: false, project: null, error: "That folder already exists." });
		await act(async () => management.confirm());
		expect(getCachedFileEditorTabs("home")).toHaveLength(1);
		expect(management.error).toBe("That folder already exists.");
		expect(management.dialog?.value).toBe("renamed");
		await act(async () => management.confirm());
		expect(api.renameFolder).toHaveBeenLastCalledWith({
			projectId: "p1",
			expectedPath: project.path,
			folderName: "renamed",
		});
		expect(getCachedFileEditorTabs("home")).toHaveLength(0);
	});

	it("reconnects a folder while preserving detached recovery drafts", async () => {
		cacheFile("saved recovery draft");
		retireFileEditorScopes({ projectId: "p1" });
		render("p1", [{ ...project, availability: { status: "unavailable", reason: "missing" } }]);
		act(() => management.requestLocate("p1"));
		act(() => management.setValue("/projects/renamed"));
		await act(async () => management.confirm());
		expect(api.locate).toHaveBeenCalledWith({
			projectId: "p1",
			expectedPath: project.path,
			path: "/projects/renamed",
		});
		expect(management.dialog).toBeNull();
		expect(getFileEditorDrafts()).toHaveLength(1);
		expect(getFileEditorDrafts()[0]).toMatchObject({ detached: true, tab: { value: "saved recovery draft" } });
	});

	it("blocks reconnect while an attached file save is in flight", async () => {
		cacheFile("saved", true);
		act(() => management.requestLocate("p1"));
		act(() => management.setValue("/projects/renamed"));
		await act(async () => management.confirm());
		expect(api.locate).not.toHaveBeenCalled();
		expect(management.error).toContain("Save or discard");
		expect(getFileEditorDrafts()[0]).toMatchObject({ detached: false, tab: { isSaving: true } });
	});

	it("keeps manual entry for cancelled or unavailable native pickers", async () => {
		act(() => management.requestLocate("p1"));
		act(() => management.setValue("/manual/path"));
		api.pickDirectory.mockResolvedValueOnce({ ok: false, path: null, reason: "cancelled", error: "Cancelled" });
		await act(async () => management.pickFolder());
		expect(management.dialog?.value).toBe("/manual/path");
		expect(management.error).toBeNull();
		api.pickDirectory.mockResolvedValueOnce({
			ok: false,
			path: null,
			reason: "native_ui_unavailable",
			error: "No picker",
		});
		await act(async () => management.pickFolder());
		expect(management.dialog?.value).toBe("/manual/path");
		expect(management.error).toContain("Enter the folder path");
		api.pickDirectory.mockResolvedValueOnce({ ok: true, path: "/picked/path", outcome: "native" });
		await act(async () => management.pickFolder());
		expect(management.dialog?.value).toBe("/picked/path");
		expect(api.locate).not.toHaveBeenCalled();
	});

	it("admits one folder mutation while a confirmation is already pending", async () => {
		let finish: ((value: { ok: boolean; project: RuntimeProjectSummary }) => void) | undefined;
		api.renameFolder.mockImplementationOnce(
			() =>
				new Promise((resolve) => {
					finish = resolve;
				}),
		);
		act(() => management.requestRenameFolder("p1"));
		act(() => management.setValue("renamed"));
		let saving: Promise<void> | undefined;
		await act(async () => {
			saving = management.confirm();
		});
		await act(async () => {
			await management.confirm();
			management.close();
		});
		expect(api.renameFolder).toHaveBeenCalledTimes(1);
		expect(management.dialog?.action).toBe("rename_folder");
		expect(management.pendingProjectId).toBe("p1");
		await act(async () => {
			finish?.({ ok: true, project });
			await saving;
		});
		expect(management.dialog).toBeNull();
	});

	it.each(["..", ".", "folder/child", "folder\\child"])(
		"rejects invalid folder name %s before filesystem intent",
		async (value) => {
			act(() => management.requestRenameFolder("p1"));
			act(() => management.setValue(value));
			await act(async () => management.confirm());
			expect(api.renameFolder).not.toHaveBeenCalled();
			expect(flushBoardCommands).not.toHaveBeenCalled();
		},
	);

	it("offers locate and name changes for an unavailable project, but cannot open disk rename", async () => {
		render("p1", [{ ...project, availability: { status: "unavailable", reason: "missing" } }]);
		act(() => management.requestRenameFolder("p1"));
		expect(management.dialog).toBeNull();
		act(() => management.requestLocate("p1"));
		expect(management.dialog?.action).toBe("locate");
		act(() => management.close());
		act(() => management.requestRename("p1"));
		expect(management.dialog?.action).toBe("rename");
		await act(async () => management.checkAvailability("p1"));
		expect(api.checkAvailability).toHaveBeenCalledWith({ projectId: "p1" });
	});
});
