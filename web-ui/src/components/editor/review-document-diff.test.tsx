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
	it("admits resulting-file full text without enabling comments and retains rename metadata", async () => {
		await act(async () =>
			root.render(
				<ReviewDocumentDiff
					viewMode="resulting"
					document={createReviewDocument(
						{
							repository: { projectId: "p", taskId: null },
							revisions: { kind: "compare", base: "main", head: "task" },
						},
						{ path: "new.ts", previousPath: "old.ts" },
						{ kind: "text", oldText: "before\n", newText: "after\n" },
					)}
				/>,
			),
		);
		expect(host.textContent).toContain("Renamed from old.ts");
		expect(host.textContent).not.toContain("before");
		expect(host.querySelector("button[aria-expanded]")).not.toBeNull();
		expect(host.querySelector(".kb-diff-comment-gutter")).toBeNull();
	});

	it.each([
		[{ kind: "text", oldText: "", newText: "" }, undefined, "Empty file"],
		[{ kind: "text", oldText: "", newText: "" }, "deleted", "Deleted file"],
		[{ kind: "binary" }, undefined, "Binary file"],
		[{ kind: "loading" }, undefined, "Loading diff"],
		[{ kind: "unavailable", message: "Missing snapshot" }, undefined, "Missing snapshot"],
		[{ kind: "patch", patch: "@@ -1 +1 @@\n-before\n+after\n" }, undefined, "before"],
	] satisfies [ReviewContent, string | undefined, string][])(
		"preserves resulting-mode admission for %j",
		async (content, status, expected) => {
			await act(async () =>
				root.render(
					<ReviewDocumentDiff
						viewMode="resulting"
						document={createReviewDocument(
							{
								repository: { projectId: "p", taskId: null },
								revisions: { kind: "compare", base: "main", head: "task" },
							},
							{ path: "file.ts", status },
							content,
						)}
					/>,
				),
			);
			expect(host.textContent).toContain(expected);
			expect(host.querySelector("button[aria-expanded]")).toBeNull();
		},
	);

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
