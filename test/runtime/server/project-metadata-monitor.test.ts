import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { RuntimeBoardData, RuntimeGitSyncSummary } from "../../../src/core";
import type {
	CachedHomeGitMetadata,
	CachedTaskWorktreeMetadata,
	ProjectMetadataEntry,
	TrackedTaskWorktree,
} from "../../../src/server/project-metadata-loaders";
import { createProjectMetadataMonitor } from "../../../src/server/project-metadata-monitor";

const loaderMocks = vi.hoisted(() => ({
	loadHomeGitMetadata: vi.fn(),
	loadTaskWorktreeMetadata: vi.fn(),
}));

const workdirMocks = vi.hoisted(() => ({
	resolveBaseRefForBranch: vi.fn(),
	runGit: vi.fn(),
}));

vi.mock("../../../src/server/project-metadata-loaders", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../../../src/server/project-metadata-loaders")>();
	return {
		...actual,
		loadHomeGitMetadata: loaderMocks.loadHomeGitMetadata,
		loadTaskWorktreeMetadata: loaderMocks.loadTaskWorktreeMetadata,
	};
});

vi.mock("../../../src/workdir", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../../../src/workdir")>();
	return {
		...actual,
		resolveBaseRefForBranch: workdirMocks.resolveBaseRefForBranch,
		runGit: workdirMocks.runGit,
	};
});

function createBoard(
	tasks: Array<{ taskId: string; columnId: "backlog" | "in_progress" | "review" | "trash" }>,
): RuntimeBoardData {
	const now = Date.now();
	return {
		columns: [
			{
				id: "backlog",
				title: "Backlog",
				cards: tasks.filter((task) => task.columnId === "backlog").map((task) => createCard(task.taskId, now)),
			},
			{
				id: "in_progress",
				title: "In Progress",
				cards: tasks.filter((task) => task.columnId === "in_progress").map((task) => createCard(task.taskId, now)),
			},
			{
				id: "review",
				title: "Review",
				cards: tasks.filter((task) => task.columnId === "review").map((task) => createCard(task.taskId, now)),
			},
			{
				id: "trash",
				title: "Trash",
				cards: tasks.filter((task) => task.columnId === "trash").map((task) => createCard(task.taskId, now)),
			},
		],
		dependencies: [],
	};
}

function createCard(taskId: string, now: number) {
	return {
		id: taskId,
		title: null,
		prompt: `Prompt for ${taskId}`,
		startInPlanMode: false,
		baseRef: "main",
		workingDirectory: `/worktrees/${taskId}`,
		createdAt: now,
		updatedAt: now,
	};
}

function createGitSummary(branch: string): RuntimeGitSyncSummary {
	return {
		currentBranch: branch,
		upstreamBranch: `origin/${branch}`,
		changedFiles: 0,
		additions: 0,
		deletions: 0,
		aheadCount: 0,
		behindCount: 0,
	};
}

let versionCounter = 1;

function createHomeMetadata(entry: ProjectMetadataEntry, branch: string): CachedHomeGitMetadata {
	return {
		summary: createGitSummary(branch),
		conflictState: null,
		stashCount: entry.homeGit.stashCount,
		stateToken: `home:${branch}:${versionCounter}`,
		stateVersion: versionCounter++,
	};
}

function createTaskMetadata(
	task: TrackedTaskWorktree,
	options?: {
		branch?: string | null;
		path?: string;
		changedFiles?: number;
	},
): CachedTaskWorktreeMetadata {
	const branch = options?.branch ?? `branch/${task.taskId}`;
	const path = options?.path ?? task.workingDirectory ?? `/worktrees/${task.taskId}`;
	const changedFiles = options?.changedFiles ?? 0;
	return {
		data: {
			taskId: task.taskId,
			path,
			exists: true,
			baseRef: task.baseRef,
			branch,
			isDetached: branch === null,
			headCommit: `head-${versionCounter}`,
			changedFiles,
			additions: changedFiles,
			deletions: 0,
			hasUnmergedChanges: false,
			behindBaseCount: 0,
			conflictState: null,
			stateVersion: versionCounter++,
		},
		stateToken: `task:${task.taskId}:${versionCounter}`,
		baseRefCommit: `base:${task.baseRef}`,
		originBaseRefCommit: `origin:${task.baseRef}:${versionCounter}`,
		lastKnownBranch: branch,
	};
}

function createDeferred<T>() {
	let resolve: ((value: T) => void) | null = null;
	let reject: ((error: unknown) => void) | null = null;
	const promise = new Promise<T>((res, rej) => {
		resolve = res;
		reject = rej;
	});
	if (!resolve || !reject) {
		throw new Error("Expected deferred handlers to be assigned.");
	}
	return {
		promise,
		resolve: resolve as (value: T) => void,
		reject: reject as (error: unknown) => void,
	};
}

describe("ProjectMetadataMonitor", () => {
	beforeEach(() => {
		versionCounter = 1;
		loaderMocks.loadHomeGitMetadata.mockReset();
		loaderMocks.loadTaskWorktreeMetadata.mockReset();
		workdirMocks.resolveBaseRefForBranch.mockReset();
		workdirMocks.runGit.mockReset();

		loaderMocks.loadHomeGitMetadata.mockImplementation(async (entry: ProjectMetadataEntry) => {
			return createHomeMetadata(entry, `home-${entry.projectPath}`);
		});
		loaderMocks.loadTaskWorktreeMetadata.mockImplementation(
			async (_projectPath: string, task: TrackedTaskWorktree) => {
				return createTaskMetadata(task);
			},
		);
		workdirMocks.resolveBaseRefForBranch.mockResolvedValue(null);
		workdirMocks.runGit.mockResolvedValue({ ok: true, stdout: "", stderr: "", exitCode: 0 });
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	it("refreshes home metadata independently across connected projects", async () => {
		const onMetadataUpdated = vi.fn();
		const monitor = createProjectMetadataMonitor({
			onMetadataUpdated,
		});

		await monitor.connectProject({
			projectId: "project-a",
			projectPath: "/repo-a",
			board: createBoard([{ taskId: "task-a", columnId: "in_progress" }]),
			pollIntervals: { focusedTaskPollMs: 2_000, backgroundTaskPollMs: 5_000, homeRepoPollMs: 10_000 },
		});
		await monitor.connectProject({
			projectId: "project-b",
			projectPath: "/repo-b",
			board: createBoard([{ taskId: "task-b", columnId: "review" }]),
			pollIntervals: { focusedTaskPollMs: 2_000, backgroundTaskPollMs: 5_000, homeRepoPollMs: 10_000 },
		});

		onMetadataUpdated.mockClear();
		const blockedRefresh = createDeferred<CachedHomeGitMetadata>();
		let blockedEntry: ProjectMetadataEntry | null = null;
		loaderMocks.loadHomeGitMetadata.mockImplementation(async (entry: ProjectMetadataEntry) => {
			if (entry.projectPath === "/repo-a") {
				blockedEntry = entry;
				return await blockedRefresh.promise;
			}
			return createHomeMetadata(entry, "home-/repo-b-refresh");
		});

		monitor.requestHomeRefresh("project-a");
		monitor.requestHomeRefresh("project-b");
		await vi.waitFor(() => {
			expect(blockedEntry).not.toBeNull();
			expect(onMetadataUpdated).toHaveBeenCalledWith(
				"project-b",
				expect.objectContaining({
					homeGitSummary: expect.objectContaining({ currentBranch: "home-/repo-b-refresh" }),
				}),
			);
		});

		if (!blockedEntry) {
			throw new Error("Expected the blocked project entry to be captured.");
		}
		blockedRefresh.resolve(createHomeMetadata(blockedEntry, "home-/repo-a-refresh"));
		await vi.waitFor(() => {
			expect(onMetadataUpdated).toHaveBeenCalledWith(
				"project-a",
				expect.objectContaining({
					homeGitSummary: expect.objectContaining({ currentBranch: "home-/repo-a-refresh" }),
				}),
			);
		});
		monitor.close();
	});

	it("keeps focused task polling more responsive than background polling", async () => {
		vi.useFakeTimers();

		const probeCounts = new Map<string, number>();
		loaderMocks.loadTaskWorktreeMetadata.mockImplementation(
			async (_projectPath: string, task: TrackedTaskWorktree) => {
				const nextCount = (probeCounts.get(task.taskId) ?? 0) + 1;
				probeCounts.set(task.taskId, nextCount);
				return createTaskMetadata(task, { changedFiles: nextCount });
			},
		);

		const monitor = createProjectMetadataMonitor({
			onMetadataUpdated: vi.fn(),
		});

		await monitor.connectProject({
			projectId: "project-1",
			projectPath: "/repo-1",
			board: createBoard([
				{ taskId: "task-1", columnId: "in_progress" },
				{ taskId: "task-2", columnId: "review" },
			]),
			pollIntervals: { focusedTaskPollMs: 2_000, backgroundTaskPollMs: 5_000, homeRepoPollMs: 10_000 },
		});

		monitor.setFocusedTask("project-1", "task-1");
		await vi.waitFor(() => {
			expect(probeCounts.get("task-1")).toBe(2);
		});
		probeCounts.clear();

		await vi.advanceTimersByTimeAsync(4_100);
		expect(probeCounts.get("task-1")).toBe(2);
		expect(probeCounts.get("task-2") ?? 0).toBe(0);

		await vi.advanceTimersByTimeAsync(1_000);
		expect(probeCounts.get("task-2")).toBe(1);

		monitor.close();
	});

	it("routes manual non-focused task refreshes through branch-change handling", async () => {
		const onMetadataUpdated = vi.fn();
		const onTaskBaseRefChanged = vi.fn();
		const branchByTaskId = new Map<string, string | null>([
			["task-1", "feature/task-1"],
			["task-2", "feature/task-2-old"],
		]);

		loaderMocks.loadTaskWorktreeMetadata.mockImplementation(
			async (_projectPath: string, task: TrackedTaskWorktree) => {
				return createTaskMetadata(task, {
					branch: branchByTaskId.get(task.taskId) ?? null,
				});
			},
		);
		workdirMocks.resolveBaseRefForBranch.mockResolvedValue("develop");

		const monitor = createProjectMetadataMonitor({
			onMetadataUpdated,
			onTaskBaseRefChanged,
			getProjectDefaultBaseRef: () => "main",
		});

		await monitor.connectProject({
			projectId: "project-1",
			projectPath: "/repo-1",
			board: createBoard([
				{ taskId: "task-1", columnId: "in_progress" },
				{ taskId: "task-2", columnId: "review" },
			]),
			pollIntervals: { focusedTaskPollMs: 2_000, backgroundTaskPollMs: 5_000, homeRepoPollMs: 10_000 },
		});
		monitor.setFocusedTask("project-1", "task-1");

		onMetadataUpdated.mockClear();
		onTaskBaseRefChanged.mockClear();
		workdirMocks.resolveBaseRefForBranch.mockClear();
		branchByTaskId.set("task-2", "feature/task-2-new");

		monitor.requestTaskRefresh("project-1", "task-2");
		await vi.waitFor(() => {
			expect(workdirMocks.resolveBaseRefForBranch).toHaveBeenCalledWith(
				"/worktrees/task-2",
				"feature/task-2-new",
				"main",
			);
			expect(onTaskBaseRefChanged).toHaveBeenCalledWith("project-1", "task-2", "develop");
			expect(onMetadataUpdated).toHaveBeenCalledWith(
				"project-1",
				expect.objectContaining({
					taskWorktrees: expect.arrayContaining([
						expect.objectContaining({ taskId: "task-2", branch: "feature/task-2-new" }),
					]),
				}),
			);
		});

		monitor.close();
	});

	it("follows a successful remote fetch with home and focused-task refreshes", async () => {
		vi.useFakeTimers();

		const seenHomeStateTokens: Array<string | null> = [];
		const refreshedTasks: string[] = [];
		loaderMocks.loadHomeGitMetadata.mockImplementation(async (entry: ProjectMetadataEntry) => {
			seenHomeStateTokens.push(entry.homeGit.stateToken);
			return createHomeMetadata(entry, `home-${seenHomeStateTokens.length}`);
		});
		loaderMocks.loadTaskWorktreeMetadata.mockImplementation(
			async (_projectPath: string, task: TrackedTaskWorktree) => {
				refreshedTasks.push(task.taskId);
				return createTaskMetadata(task);
			},
		);

		const monitor = createProjectMetadataMonitor({
			onMetadataUpdated: vi.fn(),
		});

		await monitor.connectProject({
			projectId: "project-1",
			projectPath: "/repo-1",
			board: createBoard([{ taskId: "task-1", columnId: "in_progress" }]),
			pollIntervals: { focusedTaskPollMs: 120_000, backgroundTaskPollMs: 120_000, homeRepoPollMs: 120_000 },
		});
		monitor.setFocusedTask("project-1", "task-1");

		seenHomeStateTokens.length = 0;
		refreshedTasks.length = 0;
		workdirMocks.runGit.mockClear();

		await vi.advanceTimersByTimeAsync(60_000);

		expect(workdirMocks.runGit).toHaveBeenCalledWith(
			"/repo-1",
			["fetch", "--all", "--prune"],
			expect.objectContaining({
				env: expect.objectContaining({ GIT_TERMINAL_PROMPT: "0" }),
			}),
		);
		expect(seenHomeStateTokens).toContain(null);
		expect(refreshedTasks).toContain("task-1");

		monitor.close();
	});

	it("restarts the remote fetch cadence when poll intervals change", async () => {
		vi.useFakeTimers();

		const monitor = createProjectMetadataMonitor({
			onMetadataUpdated: vi.fn(),
		});

		await monitor.connectProject({
			projectId: "project-1",
			projectPath: "/repo-1",
			board: createBoard([{ taskId: "task-1", columnId: "in_progress" }]),
			pollIntervals: { focusedTaskPollMs: 2_000, backgroundTaskPollMs: 5_000, homeRepoPollMs: 10_000 },
		});

		workdirMocks.runGit.mockClear();
		await vi.advanceTimersByTimeAsync(30_000);
		expect(workdirMocks.runGit).not.toHaveBeenCalled();

		monitor.setPollIntervals("project-1", {
			focusedTaskPollMs: 3_000,
			backgroundTaskPollMs: 6_000,
			homeRepoPollMs: 12_000,
		});

		await vi.advanceTimersByTimeAsync(31_000);
		expect(workdirMocks.runGit).not.toHaveBeenCalled();

		await vi.advanceTimersByTimeAsync(29_000);
		expect(workdirMocks.runGit).toHaveBeenCalledWith(
			"/repo-1",
			["fetch", "--all", "--prune"],
			expect.objectContaining({
				env: expect.objectContaining({ GIT_TERMINAL_PROMPT: "0" }),
			}),
		);

		monitor.close();
	});
});
