import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { RuntimeBoardData, RuntimeGitSyncSummary } from "../../../src/core";
import type {
	CachedHomeGitMetadata,
	CachedTaskWorktreeMetadata,
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

function createHomeMetadata(
	_projectPath: string,
	branch: string,
	currentHomeGit?: Pick<CachedHomeGitMetadata, "stashCount">,
): CachedHomeGitMetadata {
	return {
		summary: createGitSummary(branch),
		conflictState: null,
		stashCount: currentHomeGit?.stashCount ?? 0,
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

		loaderMocks.loadHomeGitMetadata.mockImplementation(
			async (projectPath: string, currentHomeGit: CachedHomeGitMetadata) => {
				return createHomeMetadata(projectPath, `home-${projectPath}`, currentHomeGit);
			},
		);
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
		});
		await monitor.connectProject({
			projectId: "project-b",
			projectPath: "/repo-b",
			board: createBoard([{ taskId: "task-b", columnId: "review" }]),
		});

		onMetadataUpdated.mockClear();
		const blockedRefresh = createDeferred<CachedHomeGitMetadata>();
		let blockedProjectPath: string | null = null;
		let blockedHomeGit: CachedHomeGitMetadata | null = null;
		loaderMocks.loadHomeGitMetadata.mockImplementation(
			async (projectPath: string, currentHomeGit: CachedHomeGitMetadata) => {
				if (projectPath === "/repo-a") {
					blockedProjectPath = projectPath;
					blockedHomeGit = currentHomeGit;
					return await blockedRefresh.promise;
				}
				return createHomeMetadata(projectPath, "home-/repo-b-refresh", currentHomeGit);
			},
		);

		monitor.requestHomeRefresh("project-a");
		monitor.requestHomeRefresh("project-b");
		await vi.waitFor(() => {
			expect(blockedProjectPath).toBe("/repo-a");
			expect(blockedHomeGit).not.toBeNull();
			expect(onMetadataUpdated).toHaveBeenCalledWith(
				"project-b",
				expect.objectContaining({
					homeGitSummary: expect.objectContaining({ currentBranch: "home-/repo-b-refresh" }),
				}),
			);
		});

		if (!blockedProjectPath || !blockedHomeGit) {
			throw new Error("Expected the blocked home refresh to be captured.");
		}
		blockedRefresh.resolve(createHomeMetadata(blockedProjectPath, "home-/repo-a-refresh", blockedHomeGit));
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
		});

		monitor.setFocusedTask("project-1", "task-1");
		await vi.waitFor(() => {
			expect(probeCounts.get("task-1")).toBe(2);
		});
		probeCounts.clear();

		await vi.advanceTimersByTimeAsync(10_100);
		expect(probeCounts.get("task-1")).toBe(2);
		expect(probeCounts.get("task-2") ?? 0).toBe(0);

		await vi.advanceTimersByTimeAsync(10_000);
		expect(probeCounts.get("task-2")).toBe(1);

		monitor.close();
	});

	it("does not run the focused-task polling timer when no task is focused", async () => {
		vi.useFakeTimers();

		const refreshedTasks: string[] = [];
		loaderMocks.loadTaskWorktreeMetadata.mockImplementation(
			async (_projectPath: string, task: TrackedTaskWorktree) => {
				refreshedTasks.push(task.taskId);
				return createTaskMetadata(task);
			},
		);
		workdirMocks.runGit.mockResolvedValue({ ok: false, stdout: "", stderr: "", exitCode: 1 });

		const monitor = createProjectMetadataMonitor({
			onMetadataUpdated: vi.fn(),
		});

		await monitor.connectProject({
			projectId: "project-1",
			projectPath: "/repo-1",
			board: createBoard([{ taskId: "task-1", columnId: "in_progress" }]),
		});

		refreshedTasks.length = 0;
		await vi.advanceTimersByTimeAsync(4_100);
		expect(refreshedTasks).toEqual([]);

		monitor.setFocusedTask("project-1", "task-1");
		await vi.waitFor(() => {
			expect(refreshedTasks).toEqual(["task-1"]);
		});

		monitor.close();
	});

	it("backs off metadata polling and pauses focused polling while the document is hidden", async () => {
		vi.useFakeTimers();

		const refreshedTasks: string[] = [];
		let homeRefreshCount = 0;
		loaderMocks.loadHomeGitMetadata.mockImplementation(
			async (projectPath: string, currentHomeGit: CachedHomeGitMetadata) => {
				homeRefreshCount += 1;
				return createHomeMetadata(projectPath, `home-${homeRefreshCount}`, currentHomeGit);
			},
		);
		loaderMocks.loadTaskWorktreeMetadata.mockImplementation(
			async (_projectPath: string, task: TrackedTaskWorktree) => {
				refreshedTasks.push(task.taskId);
				return createTaskMetadata(task);
			},
		);
		workdirMocks.runGit.mockResolvedValue({ ok: false, stdout: "", stderr: "", exitCode: 1 });

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
		});
		refreshedTasks.length = 0;
		homeRefreshCount = 0;
		monitor.setFocusedTask("project-1", "task-1");
		await vi.waitFor(() => {
			expect(refreshedTasks).toEqual(["task-1"]);
		});

		refreshedTasks.length = 0;
		homeRefreshCount = 0;
		workdirMocks.runGit.mockClear();
		monitor.setDocumentVisible("project-1", false);

		await vi.advanceTimersByTimeAsync(59_000);
		expect(refreshedTasks).toEqual([]);
		expect(homeRefreshCount).toBe(0);
		expect(workdirMocks.runGit).not.toHaveBeenCalledWith("/repo-1", ["fetch", "--all", "--prune"], expect.anything());

		await vi.advanceTimersByTimeAsync(1_000);
		expect(refreshedTasks).toEqual(["task-2"]);
		expect(homeRefreshCount).toBe(1);

		monitor.close();
	});

	it("limits metadata probes per project while letting another project refresh", async () => {
		const monitor = createProjectMetadataMonitor({
			onMetadataUpdated: vi.fn(),
		});

		await monitor.connectProject({
			projectId: "project-a",
			projectPath: "/repo-a",
			board: createBoard([
				{ taskId: "task-a-1", columnId: "in_progress" },
				{ taskId: "task-a-2", columnId: "in_progress" },
				{ taskId: "task-a-3", columnId: "review" },
			]),
		});
		await monitor.connectProject({
			projectId: "project-b",
			projectPath: "/repo-b",
			board: createBoard([{ taskId: "task-b-1", columnId: "in_progress" }]),
		});

		const blockedProjectARefreshes: Array<{
			task: TrackedTaskWorktree;
			deferred: ReturnType<typeof createDeferred<CachedTaskWorktreeMetadata>>;
		}> = [];
		let activeProjectARefreshes = 0;
		let maxActiveProjectARefreshes = 0;
		let projectBRefreshed = false;
		let blockProjectARefreshes = true;
		loaderMocks.loadTaskWorktreeMetadata.mockImplementation(
			async (projectPath: string, task: TrackedTaskWorktree) => {
				if (projectPath === "/repo-b") {
					projectBRefreshed = true;
					return createTaskMetadata(task);
				}
				if (!blockProjectARefreshes) {
					return createTaskMetadata(task);
				}
				const blocked = { task, deferred: createDeferred<CachedTaskWorktreeMetadata>() };
				blockedProjectARefreshes.push(blocked);
				activeProjectARefreshes += 1;
				maxActiveProjectARefreshes = Math.max(maxActiveProjectARefreshes, activeProjectARefreshes);
				try {
					return await blocked.deferred.promise;
				} finally {
					activeProjectARefreshes -= 1;
				}
			},
		);

		monitor.requestTaskRefresh("project-a", "task-a-1");
		monitor.requestTaskRefresh("project-a", "task-a-2");
		monitor.requestTaskRefresh("project-a", "task-a-3");
		monitor.requestTaskRefresh("project-b", "task-b-1");

		await vi.waitFor(() => {
			expect(projectBRefreshed).toBe(true);
			expect(maxActiveProjectARefreshes).toBe(2);
		});

		blockProjectARefreshes = false;
		for (const blocked of blockedProjectARefreshes) {
			blocked.deferred.resolve(createTaskMetadata(blocked.task));
		}

		monitor.close();
	});

	it("keeps newer targeted task refresh metadata when a full refresh resolves later", async () => {
		const onMetadataUpdated = vi.fn();
		const monitor = createProjectMetadataMonitor({
			onMetadataUpdated,
		});
		const board = createBoard([{ taskId: "task-1", columnId: "in_progress" }]);

		await monitor.connectProject({
			projectId: "project-1",
			projectPath: "/repo-1",
			board,
		});

		const staleFullRefresh = createDeferred<CachedTaskWorktreeMetadata>();
		let sawBlockedFullRefresh = false;
		loaderMocks.loadTaskWorktreeMetadata.mockImplementation(
			async (_projectPath: string, task: TrackedTaskWorktree, current: CachedTaskWorktreeMetadata | null) => {
				if (task.taskId !== "task-1") {
					return createTaskMetadata(task);
				}
				if (current?.stateToken === null) {
					return createTaskMetadata(task, {
						branch: "feature/task-1-targeted",
						changedFiles: 7,
					});
				}
				sawBlockedFullRefresh = true;
				return await staleFullRefresh.promise;
			},
		);

		onMetadataUpdated.mockClear();
		const fullRefreshPromise = monitor.updateProjectState({
			projectId: "project-1",
			projectPath: "/repo-1",
			board,
		});
		await vi.waitFor(() => {
			expect(sawBlockedFullRefresh).toBe(true);
		});

		monitor.requestTaskRefresh("project-1", "task-1");
		await vi.waitFor(() => {
			expect(onMetadataUpdated).toHaveBeenCalledWith(
				"project-1",
				expect.objectContaining({
					taskWorktrees: [
						expect.objectContaining({
							taskId: "task-1",
							branch: "feature/task-1-targeted",
							changedFiles: 7,
						}),
					],
				}),
			);
		});

		staleFullRefresh.resolve(
			createTaskMetadata(
				{
					taskId: "task-1",
					baseRef: "main",
					workingDirectory: "/worktrees/task-1",
				},
				{
					branch: "feature/task-1-stale",
					changedFiles: 1,
				},
			),
		);
		const finalSnapshot = await fullRefreshPromise;
		expect(finalSnapshot.taskWorktrees).toEqual([
			expect.objectContaining({
				taskId: "task-1",
				branch: "feature/task-1-targeted",
				changedFiles: 7,
			}),
		]);

		monitor.close();
	});

	it("reruns a full refresh when tracked tasks change mid-flight", async () => {
		const monitor = createProjectMetadataMonitor({
			onMetadataUpdated: vi.fn(),
		});
		const boardOne = createBoard([{ taskId: "task-1", columnId: "in_progress" }]);
		const boardTwo = createBoard([
			{ taskId: "task-1", columnId: "in_progress" },
			{ taskId: "task-2", columnId: "review" },
		]);

		await monitor.connectProject({
			projectId: "project-1",
			projectPath: "/repo-1",
			board: boardOne,
		});

		const blockedTaskOneRefresh = createDeferred<CachedTaskWorktreeMetadata>();
		let sawBlockedPass = false;
		let taskTwoLoadCount = 0;
		loaderMocks.loadTaskWorktreeMetadata.mockImplementation(
			async (_projectPath: string, task: TrackedTaskWorktree) => {
				if (task.taskId === "task-1" && !sawBlockedPass) {
					sawBlockedPass = true;
					return await blockedTaskOneRefresh.promise;
				}
				if (task.taskId === "task-2") {
					taskTwoLoadCount += 1;
				}
				return createTaskMetadata(task);
			},
		);

		const firstUpdatePromise = monitor.updateProjectState({
			projectId: "project-1",
			projectPath: "/repo-1",
			board: boardOne,
		});
		await vi.waitFor(() => {
			expect(sawBlockedPass).toBe(true);
		});

		const secondUpdatePromise = monitor.updateProjectState({
			projectId: "project-1",
			projectPath: "/repo-1",
			board: boardTwo,
		});

		blockedTaskOneRefresh.resolve(
			createTaskMetadata({
				taskId: "task-1",
				baseRef: "main",
				workingDirectory: "/worktrees/task-1",
			}),
		);

		const firstSnapshot = await firstUpdatePromise;
		const secondSnapshot = await secondUpdatePromise;

		expect(taskTwoLoadCount).toBe(1);
		expect(firstSnapshot.taskWorktrees.map((task) => task.taskId)).toEqual(["task-1", "task-2"]);
		expect(secondSnapshot.taskWorktrees.map((task) => task.taskId)).toEqual(["task-1", "task-2"]);

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
		loaderMocks.loadHomeGitMetadata.mockImplementation(
			async (projectPath: string, currentHomeGit: CachedHomeGitMetadata) => {
				seenHomeStateTokens.push(currentHomeGit.stateToken);
				return createHomeMetadata(projectPath, `home-${seenHomeStateTokens.length}`, currentHomeGit);
			},
		);
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
		});
		monitor.setFocusedTask("project-1", "task-1");

		seenHomeStateTokens.length = 0;
		refreshedTasks.length = 0;
		workdirMocks.runGit.mockClear();

		await vi.advanceTimersByTimeAsync(120_000);

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
});
