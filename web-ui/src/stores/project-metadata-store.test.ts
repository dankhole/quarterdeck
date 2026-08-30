import { afterEach, describe, expect, it } from "vitest";
import type { RuntimeProjectMetadata } from "@/runtime/types";
import {
	clearTaskRepositoryInfo,
	clearTaskWorktreeInfo,
	clearTaskWorktreeSnapshot,
	getHomeGitStateVersion,
	getProjectMetadataProjectId,
	getProjectPath,
	getTaskWorktreeInfo,
	getTaskWorktreeSnapshot,
	replaceProjectMetadata,
	resetProjectMetadataStore,
	setHomeGitSummary,
	setProjectMetadataScope,
	setProjectPath,
	setTaskWorktreeInfo,
} from "@/stores/project-metadata-store";

function createMetadata(branch: string, path: string, stateVersion: number): RuntimeProjectMetadata {
	return {
		homeGitSummary: {
			currentBranch: branch,
			upstreamBranch: null,
			changedFiles: 0,
			additions: 0,
			deletions: 0,
			aheadCount: 0,
			behindCount: 0,
		},
		homeGitStateVersion: stateVersion,
		homeConflictState: null,
		homeStashCount: 0,
		taskWorktrees: [
			{
				taskId: "shared-task-id",
				path,
				exists: true,
				baseRef: "main",
				branch,
				isDetached: false,
				headCommit: `${branch}-commit`,
				changedFiles: 0,
				additions: 0,
				deletions: 0,
				hasUnmergedChanges: false,
				behindBaseCount: 0,
				conflictState: null,
				stateVersion,
			},
		],
	};
}

describe("project metadata store scoping", () => {
	afterEach(() => {
		resetProjectMetadataStore();
	});

	it("clears task Git identity atomically when the project scope changes", () => {
		setProjectMetadataScope("project-a");
		setProjectPath("project-a", "/repo/a");
		expect(replaceProjectMetadata("project-a", createMetadata("feature/a", "/repo/a/task", 1))).toBe(true);
		expect(getTaskWorktreeInfo("shared-task-id")?.branch).toBe("feature/a");

		setProjectMetadataScope("project-b");

		expect(getProjectMetadataProjectId()).toBe("project-b");
		expect(getProjectPath()).toBeNull();
		expect(getTaskWorktreeInfo("shared-task-id")).toBeNull();
		expect(getHomeGitStateVersion()).toBe(0);
	});

	it("rejects late stream and command results from the project being left", () => {
		setProjectMetadataScope("project-a");
		expect(replaceProjectMetadata("project-a", createMetadata("feature/a", "/repo/a/task", 1))).toBe(true);
		setProjectMetadataScope("project-b");
		expect(replaceProjectMetadata("project-b", createMetadata("feature/b", "/repo/b/task", 2))).toBe(true);

		expect(replaceProjectMetadata("project-a", createMetadata("feature/stale", "/repo/a/task", 3))).toBe(false);
		expect(
			setHomeGitSummary("project-a", {
				currentBranch: "feature/stale",
				upstreamBranch: null,
				changedFiles: 10,
				additions: 10,
				deletions: 0,
				aheadCount: 0,
				behindCount: 0,
			}),
		).toBe(false);
		expect(setProjectPath("project-a", "/repo/a/stale")).toBe(false);
		expect(getProjectPath()).toBeNull();
		expect(getTaskWorktreeInfo("shared-task-id")?.branch).toBe("feature/b");
		expect(getHomeGitStateVersion()).toBe(2);
	});

	it("rejects late task metadata clears from the project being left", () => {
		setProjectMetadataScope("project-a");
		expect(replaceProjectMetadata("project-a", createMetadata("feature/a", "/repo/a/task", 1))).toBe(true);
		setProjectMetadataScope("project-b");
		expect(replaceProjectMetadata("project-b", createMetadata("feature/b", "/repo/b/task", 2))).toBe(true);

		expect(clearTaskWorktreeInfo("project-a", "shared-task-id")).toBe(false);
		expect(clearTaskRepositoryInfo("project-a", "shared-task-id")).toBe(false);
		expect(clearTaskWorktreeSnapshot("project-a", "shared-task-id")).toBe(false);
		expect(getTaskWorktreeInfo("shared-task-id")?.branch).toBe("feature/b");
		expect(getTaskWorktreeSnapshot("shared-task-id")?.branch).toBe("feature/b");

		expect(clearTaskRepositoryInfo("project-b", "shared-task-id")).toBe(true);
		expect(clearTaskWorktreeSnapshot("project-b", "shared-task-id")).toBe(true);
		expect(getTaskWorktreeInfo("shared-task-id")).toBeNull();
		expect(getTaskWorktreeSnapshot("shared-task-id")).toBeNull();
	});

	it("does not emit a metadata change for a Windows path casing alias", () => {
		setProjectMetadataScope("project-a");
		const info = {
			taskId: "task-a",
			path: "C:\\Repo\\Task",
			exists: true,
			baseRef: "main",
			branch: "feature/task",
			isDetached: false,
			headCommit: "abc123",
		};

		expect(setTaskWorktreeInfo("project-a", info)).toBe(true);
		expect(setTaskWorktreeInfo("project-a", { ...info, path: "c:/repo/task/" })).toBe(false);
	});
});
