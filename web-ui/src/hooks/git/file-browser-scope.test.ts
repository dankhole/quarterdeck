import { describe, expect, it } from "vitest";

import {
	createFileContentRequest,
	createFileSaveRequest,
	createListFilesRequest,
	resolveFileBrowserMutationBlockedReason,
	resolveFileBrowserScope,
} from "./file-browser-scope";

describe("file browser scope policy", () => {
	it("models live task scopes as mutable runtime requests", () => {
		const scope = resolveFileBrowserScope({
			projectId: "project-1",
			taskId: "task-1",
			baseRef: "main",
		});

		expect(scope.contentScopeKey).toContain("task-1");
		expect(scope.searchScope).toEqual({ taskId: "task-1", baseRef: "main" });
		expect(scope.canQueryRuntime).toBe(true);
		expect(scope.isReadOnly).toBe(false);
		expect(createListFilesRequest(scope)).toEqual({ taskId: "task-1", baseRef: "main" });
		expect(createFileContentRequest(scope, "src/app.ts")).toEqual({
			taskId: "task-1",
			baseRef: "main",
			path: "src/app.ts",
		});
		expect(createFileSaveRequest(scope, "src/app.ts", "next", "hash-1")).toEqual({
			taskId: "task-1",
			baseRef: "main",
			path: "src/app.ts",
			content: "next",
			expectedContentHash: "hash-1",
		});
	});

	it("models branch/ref browsing as read-only and blocks file mutations", () => {
		const scope = resolveFileBrowserScope({
			projectId: "project-1",
			taskId: null,
			ref: "feature/refactor",
		});

		expect(scope.searchScope).toEqual({ taskId: null, ref: "feature/refactor" });
		expect(scope.isReadOnly).toBe(true);
		expect(createListFilesRequest(scope)).toEqual({ taskId: null, ref: "feature/refactor" });
		expect(resolveFileBrowserMutationBlockedReason({ scope, fileListData: { files: [], mutable: false } })).toBe(
			"Branch/ref browsing is read-only.",
		);
	});

	it("keeps search scope available while runtime IO is disabled", () => {
		const scope = resolveFileBrowserScope({
			projectId: "project-1",
			taskId: null,
			enabled: false,
		});

		expect(scope.searchScope).toEqual({ taskId: null });
		expect(scope.canQueryRuntime).toBe(false);
		expect(resolveFileBrowserMutationBlockedReason({ scope, fileListData: null })).toBe("Files view is not active.");
	});
});
