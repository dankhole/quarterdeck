import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DesktopBridge } from "../../../../src/shared/desktop-bridge-contract";
import { DESKTOP_DRAFT_SAVE_MAX_BYTES } from "../../../../src/shared/desktop-bridge-contract";
import type { FileEditorDraft } from "./file-editor-cache";
import { exportFileEditorDraft } from "./file-editor-draft-export";
import { createFileEditorTab } from "./file-editor-workspace";

describe("file draft export", () => {
	const save = vi.fn<NonNullable<DesktopBridge["saveEditorDraft"]>>();
	let draft: FileEditorDraft;
	beforeEach(() => {
		const tab = createFileEditorTab("folder/draft.ts", {
			content: "saved",
			contentHash: "hash",
			language: "typescript",
			binary: false,
			truncated: false,
			size: 5,
			editable: true,
		});
		draft = {
			id: "draft",
			scopeKey: "scope",
			generation: 1,
			scope: { projectId: "project", taskId: null },
			detached: true,
			tab: { ...tab, value: "unsaved text" },
		};
		Object.defineProperty(window, "quarterdeckDesktop", { configurable: true, value: { saveEditorDraft: save } });
	});
	afterEach(() => {
		Reflect.deleteProperty(window, "quarterdeckDesktop");
		vi.restoreAllMocks();
		vi.resetAllMocks();
	});

	it("uses the narrow native save action with basename and preserves the draft on save or cancel", async () => {
		for (const kind of ["saved", "cancelled"] as const) {
			save.mockResolvedValueOnce({ kind });
			expect(await exportFileEditorDraft(draft)).toBe(kind);
			expect(save).toHaveBeenLastCalledWith({ suggestedName: "draft.ts", content: "unsaved text" });
			expect(draft.tab.value).toBe("unsaved text");
			expect(draft.tab.savedValue).toBe("saved");
		}
	});
	it("keeps text after unavailable, denied, or oversized native export", async () => {
		save.mockRejectedValueOnce(new Error("Denied"));
		expect(await exportFileEditorDraft(draft)).toBe("failed");
		Object.defineProperty(window, "quarterdeckDesktop", { configurable: true, value: undefined });
		expect(await exportFileEditorDraft(draft)).toBe("failed");
		Object.defineProperty(window, "quarterdeckDesktop", { configurable: true, value: { saveEditorDraft: save } });
		const oversized = { ...draft, tab: { ...draft.tab, value: "a".repeat(DESKTOP_DRAFT_SAVE_MAX_BYTES + 1) } };
		expect(await exportFileEditorDraft(oversized)).toBe("failed");
		expect(save).toHaveBeenCalledTimes(1);
		expect(oversized.tab.value.length).toBe(DESKTOP_DRAFT_SAVE_MAX_BYTES + 1);
	});
	it("never substitutes a browser download when native saving is unavailable", async () => {
		Object.defineProperty(window, "quarterdeckDesktop", { configurable: true, value: undefined });
		const click = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => undefined);
		expect(await exportFileEditorDraft(draft)).toBe("failed");
		expect(click).not.toHaveBeenCalled();
		expect(draft.tab.value).toBe("unsaved text");
	});
});
