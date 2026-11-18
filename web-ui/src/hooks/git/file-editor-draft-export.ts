import {
	desktopDraftSaveRequestSchema,
	desktopDraftSaveResponseSchema,
} from "../../../../src/shared/desktop-bridge-contract";
import type { FileEditorDraft } from "./file-editor-cache";

/** Exports a snapshot without clearing or replacing the editor's unsaved text. */
export async function exportFileEditorDraft(draft: FileEditorDraft): Promise<"saved" | "cancelled" | "failed"> {
	const suggestedName = draft.tab.path.split(/[\\/]/u).at(-1) || "draft.txt";
	const request = desktopDraftSaveRequestSchema.safeParse({ suggestedName, content: draft.tab.value });
	if (!request.success || !window.quarterdeckDesktop?.saveEditorDraft) return "failed";
	try {
		const result = desktopDraftSaveResponseSchema.safeParse(
			await window.quarterdeckDesktop.saveEditorDraft(request.data),
		);
		return result.success ? result.data.kind : "failed";
	} catch {
		return "failed";
	}
}
