import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getRuntimeEnvironment } from "@/runtime/runtime-environment";
import type { DesktopBridge } from "../../../../src/shared/desktop-bridge-contract";
import { DESKTOP_DRAFT_SAVE_MAX_BYTES } from "../../../../src/shared/desktop-bridge-contract";
import type { FileEditorDraft } from "./file-editor-cache";
import { exportFileEditorDraft } from "./file-editor-draft-export";
import { createFileEditorTab } from "./file-editor-workspace";

vi.mock("@/runtime/runtime-environment", () => ({ getRuntimeEnvironment: vi.fn() }));

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
		vi.mocked(getRuntimeEnvironment).mockReturnValue({
			kind: "desktop",
			runtimeOrigin: "http://127.0.0.1:54321",
			runtimeGeneration: "current",
			capabilities: { desktop: true, nativeDialogs: true, nativeNotifications: false },
		});
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
	it("preserves ordinary browser Blob download and revokes its URL", async () => {
		vi.mocked(getRuntimeEnvironment).mockReturnValue({ kind: "browser", runtimeOrigin: "https://example.test" });
		const create = vi.fn(() => "blob:test");
		const revoke = vi.fn();
		vi.stubGlobal("URL", { createObjectURL: create, revokeObjectURL: revoke });
		const click = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => undefined);
		expect(await exportFileEditorDraft(draft)).toBe("saved");
		expect(click).toHaveBeenCalledTimes(1);
		expect(create).toHaveBeenCalledTimes(1);
		expect(revoke).toHaveBeenCalledWith("blob:test");
		expect(save).not.toHaveBeenCalled();
		vi.unstubAllGlobals();
	});
});
