import { describe, expect, it } from "vitest";

import {
	applyWorkspaceGitStatusUpdate,
	getHomeGitChangeRevision,
	getHomeGitSummary,
	getTaskWorkspaceChangeRevision,
	getTaskWorkspaceInfo,
	getTaskWorkspaceSnapshot,
	resetWorkspaceMetadataStore,
} from "@/stores/workspace-metadata-store";

describe("workspace-metadata-store", () => {
	it("applies streamed git status updates for home and task metadata", () => {
		resetWorkspaceMetadataStore();

		applyWorkspaceGitStatusUpdate({
			homeSummary: {
				currentBranch: "main",
				upstreamBranch: "origin/main",
				changedFiles: 1,
				additions: 3,
				deletions: 1,
				aheadCount: 0,
				behindCount: 0,
			},
			homeChangeRevision: 2,
			tasks: [
				{
					taskId: "task-1",
					baseRef: "main",
					path: "/tmp/task-1",
					exists: true,
					branch: "task-1",
					isDetached: false,
					headCommit: "abc123",
					changedFiles: 2,
					additions: 10,
					deletions: 4,
					changeRevision: 5,
				},
			],
		});

		expect(getHomeGitSummary()?.currentBranch).toBe("main");
		expect(getHomeGitChangeRevision()).toBe(2);
		expect(getTaskWorkspaceInfo("task-1", "main")?.branch).toBe("task-1");
		expect(getTaskWorkspaceSnapshot("task-1")?.changedFiles).toBe(2);
		expect(getTaskWorkspaceChangeRevision("task-1")).toBe(5);
	});

	it("removes task metadata absent from the next streamed update", () => {
		resetWorkspaceMetadataStore();

		applyWorkspaceGitStatusUpdate({
			homeSummary: {
				currentBranch: "main",
				upstreamBranch: "origin/main",
				changedFiles: 0,
				additions: 0,
				deletions: 0,
				aheadCount: 0,
				behindCount: 0,
			},
			homeChangeRevision: 1,
			tasks: [
				{
					taskId: "task-keep",
					baseRef: "main",
					path: "/tmp/task-keep",
					exists: true,
					branch: "task-keep",
					isDetached: false,
					headCommit: "aaa111",
					changedFiles: 1,
					additions: 1,
					deletions: 0,
					changeRevision: 1,
				},
				{
					taskId: "task-remove",
					baseRef: "main",
					path: "/tmp/task-remove",
					exists: true,
					branch: "task-remove",
					isDetached: false,
					headCommit: "bbb222",
					changedFiles: 1,
					additions: 1,
					deletions: 0,
					changeRevision: 1,
				},
			],
		});

		applyWorkspaceGitStatusUpdate({
			homeSummary: {
				currentBranch: "main",
				upstreamBranch: "origin/main",
				changedFiles: 0,
				additions: 0,
				deletions: 0,
				aheadCount: 0,
				behindCount: 0,
			},
			homeChangeRevision: 1,
			tasks: [
				{
					taskId: "task-keep",
					baseRef: "main",
					path: "/tmp/task-keep",
					exists: true,
					branch: "task-keep",
					isDetached: false,
					headCommit: "aaa111",
					changedFiles: 1,
					additions: 1,
					deletions: 0,
					changeRevision: 1,
				},
			],
		});

		expect(getTaskWorkspaceInfo("task-remove", "main")).toBeNull();
		expect(getTaskWorkspaceSnapshot("task-remove")).toBeNull();
		expect(getTaskWorkspaceChangeRevision("task-remove")).toBe(0);
	});

	it("applies revision-only updates even when git summary totals are unchanged", () => {
		resetWorkspaceMetadataStore();

		applyWorkspaceGitStatusUpdate({
			homeSummary: {
				currentBranch: "main",
				upstreamBranch: "origin/main",
				changedFiles: 1,
				additions: 1,
				deletions: 0,
				aheadCount: 0,
				behindCount: 0,
			},
			homeChangeRevision: 1,
			tasks: [
				{
					taskId: "task-1",
					baseRef: "main",
					path: "/tmp/task-1",
					exists: true,
					branch: "task-1",
					isDetached: false,
					headCommit: "abc123",
					changedFiles: 1,
					additions: 1,
					deletions: 0,
					changeRevision: 2,
				},
			],
		});

		applyWorkspaceGitStatusUpdate({
			homeSummary: {
				currentBranch: "main",
				upstreamBranch: "origin/main",
				changedFiles: 1,
				additions: 1,
				deletions: 0,
				aheadCount: 0,
				behindCount: 0,
			},
			homeChangeRevision: 2,
			tasks: [
				{
					taskId: "task-1",
					baseRef: "main",
					path: "/tmp/task-1",
					exists: true,
					branch: "task-1",
					isDetached: false,
					headCommit: "abc123",
					changedFiles: 1,
					additions: 1,
					deletions: 0,
					changeRevision: 3,
				},
			],
		});

		expect(getHomeGitChangeRevision()).toBe(2);
		expect(getTaskWorkspaceSnapshot("task-1")?.changedFiles).toBe(1);
		expect(getTaskWorkspaceChangeRevision("task-1")).toBe(3);
	});
});
