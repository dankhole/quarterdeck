import { afterEach, describe, expect, it } from "vitest";

import type { RuntimeFileContentResponse } from "@/runtime/types";
import {
	clearCachedFileEditorTabs,
	closeFileEditorTab,
	createFileEditorTab,
	deleteFileEditorEntryPath,
	getCachedFileEditorTabs,
	hasDirtyCachedFileEditorTabs,
	hasDirtyFileEditorEntryPath,
	isFileEditorTabEditable,
	markFileEditorTabSaved,
	normalizeFileEditorAutosaveMode,
	renameFileEditorEntryPath,
	setCachedFileEditorTabs,
	updateFileEditorTabValue,
	upsertLoadedFileEditorTab,
} from "./file-editor-workspace";

function contentResponse(content: string, hash: string): RuntimeFileContentResponse {
	return {
		content,
		language: "typescript",
		binary: false,
		size: content.length,
		truncated: false,
		contentHash: hash,
	};
}

describe("file editor workspace", () => {
	afterEach(() => {
		clearCachedFileEditorTabs();
	});

	it("normalizes stored autosave modes", () => {
		expect(normalizeFileEditorAutosaveMode("off")).toBe("off");
		expect(normalizeFileEditorAutosaveMode("delay")).toBe("delay");
		expect(normalizeFileEditorAutosaveMode("focus")).toBe("focus");
		expect(normalizeFileEditorAutosaveMode("unknown")).toBe("off");
		expect(normalizeFileEditorAutosaveMode(null)).toBe("off");
	});

	it("does not overwrite dirty tab content when a background load returns", () => {
		const tab = createFileEditorTab("src/app.ts", contentResponse("old", "hash-1"));
		const dirtyTab = { ...tab, value: "local edit" };

		const tabs = upsertLoadedFileEditorTab([dirtyTab], "src/app.ts", contentResponse("external edit", "hash-2"));

		expect(tabs[0]?.value).toBe("local edit");
		expect(tabs[0]?.savedValue).toBe("old");
		expect(tabs[0]?.contentHash).toBe("hash-1");
	});

	it("force reload replaces dirty tab content and baseline", () => {
		const tab = createFileEditorTab("src/app.ts", contentResponse("old", "hash-1"));
		const dirtyTab = { ...tab, value: "local edit" };

		const tabs = upsertLoadedFileEditorTab([dirtyTab], "src/app.ts", contentResponse("external edit", "hash-2"), {
			force: true,
		});

		expect(tabs[0]?.value).toBe("external edit");
		expect(tabs[0]?.savedValue).toBe("external edit");
		expect(tabs[0]?.contentHash).toBe("hash-2");
	});

	it("preserves edits typed while a save is in flight", () => {
		const tab = createFileEditorTab("src/app.ts", contentResponse("old", "hash-1"));
		const savingTab = { ...tab, value: "submitted edit", isSaving: true };
		const typedAfterSaveStarted = { ...savingTab, value: "submitted edit plus more typing" };

		const tabs = markFileEditorTabSaved(
			[typedAfterSaveStarted],
			"src/app.ts",
			contentResponse("submitted edit", "hash-2"),
			"submitted edit",
		);

		expect(tabs[0]?.value).toBe("submitted edit plus more typing");
		expect(tabs[0]?.savedValue).toBe("submitted edit");
		expect(tabs[0]?.contentHash).toBe("hash-2");
		expect(tabs[0]?.isSaving).toBe(false);
	});

	it("chooses the next neighboring tab when closing the active tab", () => {
		const first = createFileEditorTab("a.ts", contentResponse("a", "hash-a"));
		const second = createFileEditorTab("b.ts", contentResponse("b", "hash-b"));
		const third = createFileEditorTab("c.ts", contentResponse("c", "hash-c"));

		const result = closeFileEditorTab([first, second, third], "b.ts", "b.ts");

		expect(result.tabs.map((tab) => tab.path)).toEqual(["a.ts", "c.ts"]);
		expect(result.nextActivePath).toBe("c.ts");
	});

	it("only edits non-binary full-content tabs in live worktree mode", () => {
		const tab = createFileEditorTab("src/app.ts", contentResponse("old", "hash-1"));

		expect(isFileEditorTabEditable(tab, false)).toBe(true);
		expect(isFileEditorTabEditable(tab, true)).toBe(false);
		expect(isFileEditorTabEditable({ ...tab, binary: true }, false)).toBe(false);
		expect(isFileEditorTabEditable({ ...tab, truncated: true }, false)).toBe(false);
		expect(isFileEditorTabEditable({ ...tab, editable: false, editBlockedReason: "Too large." }, false)).toBe(false);
		expect(isFileEditorTabEditable({ ...tab, contentHash: null }, false)).toBe(false);
	});

	it("detects dirty tabs inside a renamed or deleted folder", () => {
		const appTab = createFileEditorTab("src/app.ts", contentResponse("old", "hash-1"));
		const dirtyAppTab = updateFileEditorTabValue([appTab], "src/app.ts", "local edit")[0]!;
		const readmeTab = createFileEditorTab("README.md", contentResponse("readme", "hash-readme"));

		expect(hasDirtyFileEditorEntryPath([dirtyAppTab, readmeTab], "src", "directory")).toBe(true);
		expect(hasDirtyFileEditorEntryPath([dirtyAppTab, readmeTab], "README.md", "file")).toBe(false);
	});

	it("rewrites open tab paths when a file or folder is renamed", () => {
		const tabs = [
			createFileEditorTab("src/app.ts", contentResponse("app", "hash-app")),
			createFileEditorTab("src/components/button.ts", contentResponse("button", "hash-button")),
			createFileEditorTab("README.md", contentResponse("readme", "hash-readme")),
		];

		const renamedFolder = renameFileEditorEntryPath(tabs, "src", "lib", "directory");
		expect(renamedFolder.map((tab) => tab.path)).toEqual(["lib/app.ts", "lib/components/button.ts", "README.md"]);

		const renamedFile = renameFileEditorEntryPath(renamedFolder, "README.md", "docs/README.md", "file");
		expect(renamedFile.map((tab) => tab.path)).toEqual(["lib/app.ts", "lib/components/button.ts", "docs/README.md"]);
	});

	it("closes open tabs when a file or folder is deleted", () => {
		const tabs = [
			createFileEditorTab("src/app.ts", contentResponse("app", "hash-app")),
			createFileEditorTab("src/components/button.ts", contentResponse("button", "hash-button")),
			createFileEditorTab("README.md", contentResponse("readme", "hash-readme")),
		];

		const afterFileDelete = deleteFileEditorEntryPath(tabs, "README.md", "file");
		expect(afterFileDelete.map((tab) => tab.path)).toEqual(["src/app.ts", "src/components/button.ts"]);

		const afterFolderDelete = deleteFileEditorEntryPath(tabs, "src", "directory");
		expect(afterFolderDelete.map((tab) => tab.path)).toEqual(["README.md"]);
	});

	it("tracks dirty cached tabs across editor scopes", () => {
		const cleanTab = createFileEditorTab("src/clean.ts", contentResponse("clean", "hash-clean"));
		const dirtyTab = updateFileEditorTabValue(
			[createFileEditorTab("src/dirty.ts", contentResponse("old", "hash-dirty"))],
			"src/dirty.ts",
			"local edit",
		)[0]!;

		setCachedFileEditorTabs("scope-clean", [cleanTab]);
		expect(hasDirtyCachedFileEditorTabs()).toBe(false);

		setCachedFileEditorTabs("scope-dirty", [dirtyTab]);
		expect(getCachedFileEditorTabs("scope-dirty")).toHaveLength(1);
		expect(hasDirtyCachedFileEditorTabs()).toBe(true);

		clearCachedFileEditorTabs("scope-dirty");
		expect(hasDirtyCachedFileEditorTabs()).toBe(false);
	});
});
