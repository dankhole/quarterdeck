import { describe, expect, it, vi } from "vitest";
import {
	createDiffActionContext,
	diffCodeNavigationUnavailableReason,
	diffPointerTextOffset,
	diffTextOffset,
} from "./diff-code-navigation";
import { createReviewDocument } from "./review-document";

const review = createReviewDocument(
	{
		repository: { projectId: "p", taskId: "t" },
		revisions: { kind: "compare", base: "HEAD", head: "WORKTREE", headSource: "live-worktree" },
	},
	{ path: "a.ts" },
	{ kind: "text", oldText: "", newText: "first\r\n😀 target()\r\n" },
);

describe("diff code navigation positions", () => {
	it("counts UTF-16 across nested syntax and inline-diff spans", () => {
		const element = document.createElement("span");
		element.innerHTML =
			'<span>😀 </span><span class="inline-diff"><span>tar</span><span>get</span></span><span>()</span>';
		const text = element.querySelectorAll("span")[3]!.firstChild!;
		expect(diffTextOffset(element, text, 1)).toBe(7);
		expect(diffTextOffset(element, document.createTextNode("outside"), 1)).toBeNull();
		const context = createDiffActionContext(review, 2, 7, 4);
		expect(context).toMatchObject({
			path: "a.ts",
			documentVersion: 4,
			position: { line: 1, character: 7 },
			selection: { from: 14, to: 14 },
		});
		expect(context?.content).toBe("first\r\n😀 target()\r\n");
	});
	it("uses pointer caret APIs rather than the browser's old selection", () => {
		const element = document.createElement("span");
		element.innerHTML = "<span>prefix </span><span>symbol</span>";
		const node = element.lastChild!.firstChild!;
		const caret = vi.fn(() => ({ offsetNode: node, offset: 2 }));
		Object.defineProperty(document, "caretPositionFromPoint", { configurable: true, value: caret });
		try {
			expect(diffPointerTextOffset(element, 12, 34)).toBe(9);
			expect(caret).toHaveBeenCalledWith(12, 34);
		} finally {
			delete (document as Partial<Document>).caretPositionFromPoint;
		}
	});
	it("supports WebKit's range API and rejects missing/outside caret positions", () => {
		const element = document.createElement("span");
		element.textContent = "😀 symbol";
		const range = document.createRange();
		range.setStart(element.firstChild!, 4);
		Object.defineProperty(document, "caretRangeFromPoint", { configurable: true, value: () => range });
		try {
			expect(diffPointerTextOffset(element, 1, 2)).toBe(4);
		} finally {
			delete (document as Partial<Document>).caretRangeFromPoint;
		}
		expect(diffPointerTextOffset(element, 1, 2)).toBeNull();
	});
	it("rejects a committed WORKTREE ref or missing provenance despite its live-looking label", () => {
		for (const headSource of ["revision", undefined] as const) {
			expect(
				diffCodeNavigationUnavailableReason({ ...review, revisions: { ...review.revisions, headSource } }),
			).toContain("historical");
		}
	});
	it("rejects invalid positions, historical refs, deleted files and partial content", () => {
		expect(createDiffActionContext(review, 0, 1, 1)).toBeNull();
		expect(createDiffActionContext(review, 2, 50, 1)).toBeNull();
		expect(diffCodeNavigationUnavailableReason(review)).toBeNull();
		expect(
			diffCodeNavigationUnavailableReason({
				...review,
				revisions: { ...review.revisions, head: "branch", headSource: "revision" },
			}),
		).toContain("historical");
		expect(diffCodeNavigationUnavailableReason({ ...review, newPath: null })).toContain("complete");
		expect(diffCodeNavigationUnavailableReason({ ...review, content: { kind: "patch", patch: "@@" } })).toContain(
			"complete",
		);
	});
});
