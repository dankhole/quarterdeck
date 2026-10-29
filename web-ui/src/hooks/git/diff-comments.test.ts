// @vitest-environment node
import { describe, expect, it } from "vitest";
import type { DiffLineComment } from "@/components/git/panels/diff-viewer-utils";
import { addDiffComment, changeDiffComment, finishDiffComment, resolveDiffCommentKey } from "./diff-comments";

const original: DiffLineComment = {
	filePath: "a.ts",
	lineNumber: 1,
	lineText: "original",
	variant: "added",
	comment: "Original review",
	editing: false,
	anchorRevision: "snapshot one",
};

describe("diff comment identity", () => {
	it("creates a new immutable map identity for a different snapshot at the same address", () => {
		const comments = new Map([["original-id", original]]);
		const next = addDiffComment(comments, "a.ts", 1, "replacement", "added", "snapshot two", "new-id");
		expect(next.get("original-id")).toBe(original);
		expect(next.get("new-id")).toMatchObject({
			lineText: "replacement",
			anchorRevision: "snapshot two",
			editing: true,
		});
		expect(next.size).toBe(2);
	});

	it("reopens an existing exact snapshot without replacing its key or source context", () => {
		const next = addDiffComment(
			new Map([["original-id", original]]),
			"a.ts",
			1,
			"original",
			"added",
			"snapshot one",
			"unused-id",
		);
		expect([...next.keys()]).toEqual(["original-id"]);
		expect(next.get("original-id")).toEqual({ ...original, editing: true });
	});

	it("fails closed for ambiguous legacy addresses and mismatched exact identities", () => {
		const comments = new Map([
			["original-id", original],
			["new-id", { ...original, anchorRevision: "snapshot two" }],
		]);
		expect(resolveDiffCommentKey(comments, ["a.ts", 1, "added"])).toBeUndefined();
		expect(changeDiffComment(comments, ["a.ts", 1, "added"], { comment: "Wrong" })).toBe(comments);
		expect(finishDiffComment(comments, ["a.ts", 1, "added"], true)).toBe(comments);
		expect(changeDiffComment(comments, ["other.ts", 1, "added", "original-id"], { comment: "Wrong" })).toBe(comments);
	});

	it("never overwrites another draft if the supplied identity already exists", () => {
		const comments = new Map([["original-id", original]]);
		expect(addDiffComment(comments, "b.ts", 2, "replacement", "removed", "snapshot two", "original-id")).toBe(
			comments,
		);
	});
});
