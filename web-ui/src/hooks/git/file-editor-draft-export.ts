import { getRuntimeEnvironment } from "@/runtime/runtime-environment";
import {
	desktopDraftSaveRequestSchema,
	desktopDraftSaveResponseSchema,
} from "../../../../src/shared/desktop-bridge-contract";
import type { FileEditorDraft } from "./file-editor-cache";

/** Exports a snapshot without clearing or replacing the editor's unsaved text. */
export async function exportFileEditorDraft(draft: FileEditorDraft): Promise<"saved" | "cancelled" | "failed"> {
	const suggestedName = draft.tab.path.split(/[\\/]/u).at(-1) || "draft.txt";
	if (getRuntimeEnvironment().kind === "desktop") {
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
	const url = URL.createObjectURL(new Blob([draft.tab.value], { type: "text/plain;charset=utf-8" }));
	try {
		const link = document.createElement("a");
		link.href = url;
		link.download = suggestedName;
		link.click();
		return "saved";
	} finally {
		URL.revokeObjectURL(url);
	}
}
