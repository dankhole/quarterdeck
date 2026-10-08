// @vitest-environment node

import { afterEach, describe, expect, it } from "vitest";
import { createTestProjectStateResponse } from "@/test-utils/task-session-factory";
import {
	clearCachedFileEditorTabs,
	discardFileEditorDraft,
	getCachedFileEditorTabs,
	getFileEditorDrafts,
	getFileEditorScopeGeneration,
	guardFileEditorScopes,
	hasDirtyCachedFileEditorTabs,
	reconcileFileEditorProjectState,
	reconcileFileEditorProjects,
	reconcileFileEditorWorktrees,
	registerFileEditorScope,
	retireFileEditorScopes,
	setCachedFileEditorTabs,
	updateCachedFileEditorTabs,
} from "./file-editor-cache";
import { createFileEditorTab, updateFileEditorTabValue } from "./file-editor-workspace";

function cache(scopeKey: string, projectId: string, taskId: string | null, dirty = true) {
	registerFileEditorScope(scopeKey, {
		projectId,
		taskId,
		rootPath: `/tmp/${scopeKey}`,
		taskCreatedAt: taskId ? 1 : undefined,
	});
	const tab = createFileEditorTab("app.ts", {
		content: "saved",
		contentHash: "hash",
		language: "typescript",
		binary: false,
		truncated: false,
		size: 5,
	});
	setCachedFileEditorTabs(scopeKey, [{ ...tab, value: dirty ? "draft" : tab.value }]);
}

afterEach(() => clearCachedFileEditorTabs());

describe("file editor scope lifecycle", () => {
	it("detaches dirty home drafts when a folder changes externally and fences late writes", () => {
		cache("home", "p1", null);
		const generation = getFileEditorScopeGeneration("home");
		reconcileFileEditorProjectState("p1", createTestProjectStateResponse({ repoPath: "/new" }));
		expect(getCachedFileEditorTabs("home")).toEqual([]);
		expect(getFileEditorDrafts("detached")[0]).toMatchObject({
			scope: { projectId: "p1", rootPath: "/tmp/home" },
			tab: { value: "draft" },
			detached: true,
		});
		registerFileEditorScope("home", { projectId: "p1", taskId: null, rootPath: "/new" });
		updateCachedFileEditorTabs("home", () => [getFileEditorDrafts("detached")[0]!.tab], generation);
		expect(getCachedFileEditorTabs("home")).toEqual([]);
	});

	it("preserves unavailable-project drafts without keeping a writable workspace", () => {
		cache("home", "p1", null);
		reconcileFileEditorProjects([
			{
				id: "p1",
				path: "/tmp/home",
				name: "Project",
				boardRevision: 1,
				taskCounts: { in_progress: 0, review: 0, trash: 0 },
				availability: { status: "unavailable", reason: "missing" },
			},
		]);
		expect(getCachedFileEditorTabs("home")).toEqual([]);
		expect(getFileEditorDrafts("detached")[0]?.tab.value).toBe("draft");
	});
	it("blocks only the affected project and task, including hidden tabs", () => {
		cache("one", "p1", "t1");
		cache("two", "p2", "t1");
		expect(guardFileEditorScopes({ projectId: "p1", tasks: [{ taskId: "t2", taskCreatedAt: 1 }] })).toBe(true);
		expect(guardFileEditorScopes({ projectId: "p1", tasks: [{ taskId: "t1", taskCreatedAt: 1 }] })).toBe(false);
		expect(getFileEditorDrafts().map((draft) => draft.scopeKey)).toEqual(["one"]);
	});
	it("does not retire or discard a recreated task when an old task deletion finishes", () => {
		cache("one", "p1", "t1");
		const oldDraft = getFileEditorDrafts()[0]!;
		retireFileEditorScopes({ projectId: "p1", tasks: [{ taskId: "t1", taskCreatedAt: 1 }] });
		registerFileEditorScope("one", { projectId: "p1", taskId: "t1", taskCreatedAt: 2 });
		setCachedFileEditorTabs("one", [oldDraft.tab]);
		retireFileEditorScopes({ projectId: "p1", tasks: [{ taskId: "t1", taskCreatedAt: 1 }] });
		discardFileEditorDraft(oldDraft);
		expect(getCachedFileEditorTabs("one")[0]?.value).toBe("draft");
	});

	it("prunes clean deleted scopes and preserves inaccessible drafts with their original identity", () => {
		cache("clean", "p1", "t1", false);
		cache("dirty", "p1", "t2");
		cache("other", "p2", null);
		retireFileEditorScopes({ projectId: "p1" });
		expect(getCachedFileEditorTabs("clean")).toEqual([]);
		expect(getCachedFileEditorTabs("dirty")).toEqual([]);
		const [draft] = getFileEditorDrafts("detached");
		expect(draft).toMatchObject({
			scope: { projectId: "p1", taskId: "t2", rootPath: "/tmp/dirty" },
			tab: { value: "draft" },
		});
		expect(getCachedFileEditorTabs("other")[0]?.value).toBe("draft");
		expect(hasDirtyCachedFileEditorTabs()).toBe(true);
	});
	it("does not discard a draft edited after its confirmation was shown", () => {
		cache("one", "p1", "t1");
		const draft = getFileEditorDrafts()[0]!;
		updateCachedFileEditorTabs(
			"one",
			(tabs) => updateFileEditorTabValue(tabs, "app.ts", "newer draft"),
			getFileEditorScopeGeneration("one"),
		);
		discardFileEditorDraft(draft);
		expect(getCachedFileEditorTabs("one")[0]?.value).toBe("newer draft");
		discardFileEditorDraft(getFileEditorDrafts()[0]!);
		expect(hasDirtyCachedFileEditorTabs()).toBe(false);
	});
	it("protects in-flight saves and fences their completions from a recreated scope", () => {
		cache("one", "p1", "t1");
		const generation = getFileEditorScopeGeneration("one");
		updateCachedFileEditorTabs("one", (tabs) => tabs.map((tab) => ({ ...tab, isSaving: true })), generation);
		discardFileEditorDraft(getFileEditorDrafts()[0]!);
		expect(guardFileEditorScopes({ projectId: "p1" })).toBe(false);
		retireFileEditorScopes({ projectId: "p1" });
		cache("one", "p1", "t1");
		updateCachedFileEditorTabs("one", () => [], generation);
		expect(getCachedFileEditorTabs("one")[0]?.value).toBe("draft");
		expect(getFileEditorDrafts("detached")[0]?.tab).toMatchObject({ value: "draft", isSaving: false });
	});
	it("retires deleted/recreated tasks only from the authoritative project snapshot", () => {
		cache("one", "p1", "t1");
		cache("other", "p2", "t1");
		reconcileFileEditorProjectState("p1", createTestProjectStateResponse());
		expect(getCachedFileEditorTabs("one")).toEqual([]);
		expect(getCachedFileEditorTabs("other")).toHaveLength(1);
	});
	it("treats absent worktree metadata as loading, and explicit removal as invalidation", () => {
		cache("one", "p1", "t1");
		const metadata = { homeGitSummary: null, homeGitStateVersion: 0, homeStashCount: 0, taskWorktrees: [] };
		reconcileFileEditorWorktrees("p1", metadata);
		expect(getCachedFileEditorTabs("one")).toHaveLength(1);
		reconcileFileEditorWorktrees("p1", {
			...metadata,
			taskWorktrees: [
				{
					taskId: "t1",
					path: "/tmp/one",
					exists: false,
					baseRef: "main",
					branch: null,
					isDetached: false,
					headCommit: null,
					changedFiles: null,
					additions: null,
					deletions: null,
					hasUnmergedChanges: null,
					behindBaseCount: null,
					behindRemoteBaseCount: null,
					stateVersion: 0,
				},
			],
		});
		expect(getFileEditorDrafts("detached")).toHaveLength(1);
	});
	it("retains removed-project drafts through an empty project list", () => {
		cache("one", "p1", null);
		reconcileFileEditorProjects([]);
		expect(getCachedFileEditorTabs("one")).toEqual([]);
		expect(getFileEditorDrafts("detached")).toHaveLength(1);
	});
});
