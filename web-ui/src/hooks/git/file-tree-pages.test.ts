// @vitest-environment node
import { describe, expect, it } from "vitest";
import { fileTreePage } from "@/test-utils/file-tree";
import {
	applyFileTreeMutationReceipt,
	mergeDirectoryPage,
	projectFileTree,
	projectLoadedTree,
	reconcileFileTreeMutationReceipts,
	visibleExpandedDirectories,
} from "./file-tree-pages";

describe("file tree pages", () => {
	it("deduplicates continuation pages and preserves them across first-page polling", () => {
		const first = fileTreePage({ files: ["one"], nextCursor: "next" });
		const second = fileTreePage({ files: ["one", "two"], nextCursor: "last" });
		const merged = mergeDirectoryPage(first, second, true);
		expect(merged.files).toEqual(["one", "two"]);
		expect(mergeDirectoryPage(merged, first, false)).toMatchObject({ files: ["one", "two"], nextCursor: "last" });
	});
	it("replaces reset pages, hides unreachable descendants, and leaves unrelated directories intact", () => {
		const previous = fileTreePage({ directories: ["old"], files: ["stale"] });
		const replacement = fileTreePage({ directories: ["other"], snapshotId: "new" });
		const pages = {
			"": { data: mergeDirectoryPage(previous, replacement, true), loading: false, error: null },
			old: { data: fileTreePage({ directory: "old", files: ["old/stale"] }), loading: false, error: null },
			other: { data: fileTreePage({ directory: "other", files: ["other/kept"] }), loading: false, error: null },
		};
		expect(projectLoadedTree(pages)).toEqual({ files: ["other/kept"], directories: ["other"] });
	});
	it("does not poll expanded descendants below collapsed ancestors", () => {
		expect(visibleExpandedDirectories(new Set(["src", "src/a", "closed/child"]))).toEqual(["src", "src/a"]);
	});
	it("reveals mutation paths without scanning pages and expires deletion masks on fresh enumeration", () => {
		const pages = { "": { data: fileTreePage({ files: ["deleted"] }), loading: false, error: null } };
		const receipt = applyFileTreeMutationReceipt(
			{ scopeKey: "scope", entries: new Map(), removed: new Map() },
			pages,
			"scope",
			"new/deep/file",
			"file",
			"deleted",
		);
		expect(projectFileTree(pages, receipt, "scope", false)).toEqual({
			files: ["new/deep/file"],
			directories: ["new", "new/deep"],
		});
		const refreshed = { "": { ...pages[""], data: fileTreePage({ files: ["deleted"], snapshotId: "recreated" }) } };
		expect(projectFileTree(refreshed, receipt, "scope", false).files).toContain("deleted");
		expect(projectFileTree(pages, receipt, "different", false).files).toEqual(["deleted"]);
	});
	it("retires receipt insertions only after listing inclusion or complete new-parent absence proof", () => {
		const old = { "": { data: fileTreePage({ nextCursor: "more" }), loading: false, error: null } };
		const receipt = applyFileTreeMutationReceipt(
			{ scopeKey: "scope", entries: new Map(), removed: new Map() },
			old,
			"scope",
			"beyond-page-one",
			"file",
		);
		const partial = { "": { ...old[""], data: fileTreePage({ snapshotId: "new", nextCursor: "new2" }) } };
		expect(projectFileTree(partial, receipt, "scope", false).files).toContain("beyond-page-one");
		expect(reconcileFileTreeMutationReceipts(receipt, partial)).toBe(receipt);
		const complete = { "": { ...old[""], data: fileTreePage({ snapshotId: "new" }) } };
		const reconciled = reconcileFileTreeMutationReceipts(receipt, complete);
		expect(reconciled.entries.size).toBe(0);
		expect(projectFileTree(complete, receipt, "scope", false).files).not.toContain("beyond-page-one");
		expect(projectFileTree(partial, reconciled, "scope", false).files).not.toContain("beyond-page-one");
		const included = { "": { ...old[""], data: fileTreePage({ files: ["beyond-page-one"], nextCursor: "more" }) } };
		expect(reconcileFileTreeMutationReceipts(receipt, included).entries.size).toBe(0);
	});
});
