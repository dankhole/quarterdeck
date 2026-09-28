import { EditorState } from "@codemirror/state";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createReviewDocument, type ReviewContent } from "@/hooks/git/review-document";
import { ReviewDocumentDiff } from "./review-document-diff";

describe("review document presentation", () => {
	let host: HTMLDivElement;
	let root: Root;
	beforeEach(() => {
		(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
		host = document.createElement("div");
		document.body.append(host);
		root = createRoot(host);
	});
	afterEach(() => {
		act(() => root.unmount());
		host.remove();
		vi.restoreAllMocks();
		delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
	});
	it.each(["patch", "text"] as const)("retains %s rows across unrelated parent renders", async (kind) => {
		const highlight = vi.spyOn(EditorState, "create");
		async function render(value: number) {
			const content: ReviewContent =
				kind === "patch"
					? { kind, patch: `@@ -1 +1 @@\n-const value = 0;\n+const value = ${value};` }
					: { kind, oldText: "const value = 0;", newText: `const value = ${value};` };
			await act(async () => {
				root.render(
					<ReviewDocumentDiff
						document={createReviewDocument(
							{
								repository: { projectId: "p", taskId: null },
								revisions: { kind: "conflict", base: ":2", head: ":3" },
							},
							{ path: "file.ts" },
							content,
						)}
					/>,
				);
			});
		}
		await render(1);
		const initialHighlightCount = highlight.mock.calls.length;
		expect(initialHighlightCount).toBeGreaterThan(0);
		await render(1);
		expect(highlight).toHaveBeenCalledTimes(initialHighlightCount);
		await render(2);
		expect(highlight.mock.calls.length).toBeGreaterThan(initialHighlightCount);
		expect(host.textContent).toContain("const value = 2;");
	});
});
