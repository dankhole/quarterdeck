// @vitest-environment node

import { describe, expect, it } from "vitest";
import { createFileBrowserContentScopeKey } from "./file-browser-scope";
import { createReviewDocument, type ReviewScope } from "./review-document";

const scope: ReviewScope = {
	repository: { projectId: "p", taskId: "t", rootPath: "/repo" },
	revisions: { kind: "commit", base: "a", head: "b" },
};
describe("review documents", () => {
	it("isolates revisions, repositories, renamed paths and live editor identities", () => {
		const file = { path: "new.ts", previousPath: "old.ts", status: "renamed" };
		const content = { kind: "patch", patch: "@@ -80 +80 @@\n-old\n+new" } as const;
		const doc = createReviewDocument(scope, file, content);
		expect(doc).toMatchObject({ readOnly: true, oldPath: "old.ts", newPath: "new.ts", content });
		expect(doc.key).not.toBe(createFileBrowserContentScopeKey(scope.repository));
		expect(
			createReviewDocument({ ...scope, revisions: { ...scope.revisions, head: "c" } }, file, content).key,
		).not.toBe(doc.key);
		expect(
			createReviewDocument({ ...scope, repository: { ...scope.repository, projectId: "other" } }, file, content).key,
		).not.toBe(doc.key);
		expect(createReviewDocument(scope, { ...file, previousPath: "another.ts" }, content).key).not.toBe(doc.key);
		expect(doc).not.toHaveProperty("save");
	});
	it("changes identity when identical WORKTREE labels switch between live content and a committed ref", () => {
		const content = { kind: "text", oldText: "old()", newText: "same()" } as const;
		const revisions = { kind: "compare", base: "main", head: "WORKTREE" } as const;
		const historical = createReviewDocument({ ...scope, revisions }, { path: "a.ts" }, content);
		const explicitRevision = createReviewDocument(
			{ ...scope, revisions: { ...revisions, headSource: "revision" } },
			{ path: "a.ts" },
			content,
		);
		const live = createReviewDocument(
			{ ...scope, revisions: { ...revisions, headSource: "live-worktree" } },
			{ path: "a.ts" },
			content,
		);
		expect(historical.key).toBe(explicitRevision.key);
		expect(live.key).not.toBe(historical.key);
	});
	it("keeps deletion and working-copy snapshots read-only", () => {
		const doc = createReviewDocument(
			{ ...scope, revisions: { kind: "working-copy", base: "HEAD", head: "WORKTREE", headSource: "live-worktree" } },
			{ path: "gone.ts", status: "deleted" },
			{ kind: "text", oldText: "old", newText: "" },
		);
		expect(doc).toMatchObject({ oldPath: "gone.ts", newPath: null, path: "gone.ts", readOnly: true });
	});
});
