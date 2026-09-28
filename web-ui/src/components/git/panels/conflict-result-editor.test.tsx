import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SourceEditorProps } from "@/components/editor/source-editor";
import { TooltipProvider } from "@/components/ui/tooltip";
import { resolveFileBrowserScope } from "@/hooks/git/file-browser-scope";
import {
	clearCachedFileEditorTabs,
	getCachedFileEditorTabs,
	getFileEditorDrafts,
	getFileEditorReviewTarget,
	retireFileEditorScopes,
} from "@/hooks/git/file-editor-cache";
import type { RuntimeConflictFile } from "@/runtime/types";
import { ConflictResultEditor } from "./conflict-result-editor";

const query = vi.hoisted(() => vi.fn());
const save = vi.hoisted(() => vi.fn());
vi.mock("@/runtime/trpc-client", () => ({
	getRuntimeTrpcClient: () => ({ project: { getFileContent: { query }, saveFileContent: { mutate: save } } }),
}));
vi.mock("@/components/app-toaster", () => ({ showAppToast: vi.fn() }));
vi.mock("@/components/editor/source-editor", () => ({
	SourceEditor: (props: SourceEditorProps) => (
		<textarea
			aria-label={props.readOnly ? "Source" : "Result"}
			value={props.value}
			readOnly={props.readOnly}
			onInput={(event) => props.onChange(event.currentTarget.value)}
		/>
	),
}));
const repository = { projectId: "p", taskId: "t", taskCreatedAt: 1, rootPath: "/synthetic/t", baseRef: "main" };
const scopeKey = resolveFileBrowserScope(repository).contentScopeKey;
const file = { path: "file.ts", baseContent: "base\n", oursContent: "ours\n", theirsContent: "theirs\n" };
function content(value: string, hash: string) {
	return {
		content: value,
		contentHash: hash,
		binary: false,
		truncated: false,
		language: "typescript",
		size: value.length,
		editable: true,
	};
}

describe("conflict result workspace", () => {
	let root: Root;
	let host: HTMLDivElement;
	const resolveFile = vi.fn(async () => ({ ok: true }));
	beforeEach(() => {
		(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
		clearCachedFileEditorTabs();
		query.mockReset().mockResolvedValue(content("conflicted disk\n", "disk-hash"));
		save.mockReset();
		resolveFile.mockClear();
		host = document.createElement("div");
		document.body.append(host);
		root = createRoot(host);
	});
	afterEach(() => {
		act(() => root.unmount());
		host.remove();
		clearCachedFileEditorTabs();
		delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
	});
	async function render(conflictFile: RuntimeConflictFile = file) {
		await act(async () => {
			root.render(
				<TooltipProvider>
					<ConflictResultEditor
						file={conflictFile}
						repository={repository}
						isMutating={false}
						resolveFile={resolveFile}
					/>
				</TooltipProvider>,
			);
		});
	}
	function button(label: string) {
		const found = [...host.querySelectorAll("button")].find(
			(button) => button.textContent === label || button.getAttribute("aria-label") === label,
		);
		if (!found) throw new Error(`Missing ${label}`);
		return found;
	}
	async function click(label: string) {
		await act(async () => {
			button(label).click();
		});
	}
	it("stages binary sources through Git even when the current worktree result is text", async () => {
		await render({ ...file, binary: true, theirsContent: "binary\0bytes" });
		expect(button("Use Theirs in Result").disabled).toBe(true);
		await click("Use Theirs in Result");
		expect(getCachedFileEditorTabs(scopeKey)[0]?.value).toBe("conflicted disk\n");
		await click("Use Theirs & Stage");
		expect(resolveFile).toHaveBeenCalledWith("file.ts", "theirs", "disk-hash");
		expect(save).not.toHaveBeenCalled();
	});
	it("does not replace a result with an empty string for a missing source", async () => {
		await render({ ...file, sourcesUnavailable: true, theirsContent: "" });
		expect(button("Use Theirs in Result").disabled).toBe(true);
		await click("Use Theirs in Result");
		expect(getCachedFileEditorTabs(scopeKey)[0]?.value).toBe("conflicted disk\n");
		expect(host.textContent).toContain("A conflict source is missing");
	});
	it("retains explicit complete-side resolution when the result exceeds the editor read limit", async () => {
		query.mockRejectedValue(new Error("File exceeds the read limit."));
		await render();
		expect(button("Stage & Mark Resolved").disabled).toBe(true);
		await click("Use Ours & Stage");
		expect(resolveFile).toHaveBeenCalledWith("file.ts", "ours", undefined);
	});
	it("choosing a source creates a dirty result, save does not stage, and stage uses the saved hash", async () => {
		await render();
		await click("Use Ours in Result");
		expect(getCachedFileEditorTabs(scopeKey)[0]?.value).toBe("ours\n");
		expect(save).not.toHaveBeenCalled();
		expect(resolveFile).not.toHaveBeenCalled();
		expect(button("Stage & Mark Resolved").disabled).toBe(true);
		save.mockResolvedValue(content("ours\n", "saved-hash"));
		await click("Save file");
		expect(save).toHaveBeenCalledWith({
			taskId: "t",
			baseRef: "main",
			path: "file.ts",
			content: "ours\n",
			expectedContentHash: "disk-hash",
		});
		expect(resolveFile).not.toHaveBeenCalled();
		await click("Stage & Mark Resolved");
		expect(resolveFile).toHaveBeenCalledWith("file.ts", "manual", "saved-hash");
	});
	it("preserves dirty content through source replacement, disk failure, navigation and scope retirement", async () => {
		await render();
		await click("Use Theirs in Result");
		await click("Use Ours in Result");
		expect(getFileEditorReviewTarget()).toEqual({ projectId: "p", taskId: "t" });
		expect(getCachedFileEditorTabs(scopeKey)[0]?.value).toBe("theirs\n");
		save.mockRejectedValue(new Error("File changed on disk. Reload before saving."));
		await click("Save file");
		expect(host.textContent).toContain("File changed on disk");
		expect(button("Stage & Mark Resolved").disabled).toBe(true);
		await act(async () => {
			root.render(null);
		});
		await render();
		expect((host.querySelector('textarea[aria-label="Result"]') as HTMLTextAreaElement).value).toBe("theirs\n");
		act(() => retireFileEditorScopes({ projectId: "p", taskId: "t" }));
		expect(getFileEditorDrafts("detached")).toMatchObject([{ detached: true, tab: { value: "theirs\n" } }]);
	});
});
