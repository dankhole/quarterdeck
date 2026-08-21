import { act, useCallback, useEffect, useRef, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createInitialBoardData } from "@/data/board-data";
import type { ProjectBoardSessionsState } from "@/hooks/project/project-sync";
import { useProjectSync } from "@/hooks/project/use-project-sync";
import { clearProjectBoardCache, restoreProjectBoard, stashProjectBoard } from "@/runtime/project-board-cache";
import { ProjectStateConflictError } from "@/runtime/project-state-query";
import type { RuntimeProjectStateResponse, RuntimeTaskSessionSummary } from "@/runtime/types";
import {
	createTestProjectStateResponse,
	createTestTaskHookActivity,
	createTestTaskSessionSummary,
} from "@/test-utils/task-session-factory";
import type { BoardData } from "@/types";

const fetchProjectStateMock = vi.hoisted(() => vi.fn());
const applyProjectBoardCommandsMock = vi.hoisted(() => vi.fn());

vi.mock("@/runtime/project-state-query", () => ({
	fetchProjectState: fetchProjectStateMock,
	applyProjectBoardCommands: applyProjectBoardCommandsMock,
	ProjectStateConflictError: class extends Error {
		readonly currentRevision: number;

		constructor(currentRevision: number) {
			super("Project state revision conflict.");
			this.currentRevision = currentRevision;
		}
	},
}));

function createBoard(taskId: string): BoardData {
	return createBoardInColumn("backlog", taskId);
}

function createBoardInColumn(columnId: "backlog" | "in_progress" | "review" | "trash", taskId: string): BoardData {
	return {
		columns: [
			{
				id: "backlog",
				title: "Backlog",
				cards:
					columnId === "backlog"
						? [
								{
									id: taskId,
									title: null,
									prompt: `Prompt ${taskId}`,
									baseRef: "main",
									createdAt: 1,
									updatedAt: 1,
								},
							]
						: [],
			},
			{
				id: "in_progress",
				title: "In Progress",
				cards:
					columnId === "in_progress"
						? [
								{
									id: taskId,
									title: null,
									prompt: `Prompt ${taskId}`,
									baseRef: "main",
									createdAt: 1,
									updatedAt: 1,
								},
							]
						: [],
			},
			{
				id: "review",
				title: "Review",
				cards:
					columnId === "review"
						? [
								{
									id: taskId,
									title: null,
									prompt: `Prompt ${taskId}`,
									baseRef: "main",
									createdAt: 1,
									updatedAt: 1,
								},
							]
						: [],
			},
			{
				id: "trash",
				title: "Trash",
				cards:
					columnId === "trash"
						? [
								{
									id: taskId,
									title: null,
									prompt: `Prompt ${taskId}`,
									baseRef: "main",
									createdAt: 1,
									updatedAt: 1,
								},
							]
						: [],
			},
		],
		dependencies: [],
	};
}

function createProjectState(taskId: string, revision: number): RuntimeProjectStateResponse {
	return createTestProjectStateResponse({
		board: createBoard(taskId),
		sessions: {},
		revision,
	});
}

function createSessionSummary(
	taskId: string,
	updatedAt: number,
	finalMessage: string | null,
): RuntimeTaskSessionSummary {
	return createTestTaskSessionSummary({
		taskId,
		state: finalMessage ? "awaiting_review" : "running",
		agentId: "claude",
		sessionLaunchPath: "/tmp/project-a",
		startedAt: updatedAt - 100,
		updatedAt,
		lastOutputAt: updatedAt,
		reviewReason: finalMessage ? "hook" : null,
		exitCode: null,
		lastHookAt: updatedAt,
		latestHookActivity: finalMessage
			? createTestTaskHookActivity({
					activityText: `Final: ${finalMessage}`,
					finalMessage,
					hookEventName: "agent_end",
					source: "hook",
				})
			: null,
	});
}

function createProjectStateWithSessions(
	taskId: string,
	revision: number,
	sessions: Record<string, RuntimeTaskSessionSummary>,
): RuntimeProjectStateResponse {
	return createTestProjectStateResponse({
		...createProjectState(taskId, revision),
		sessions,
	});
}

function createDeferred<T>() {
	let resolve!: (value: T) => void;
	let reject!: (reason?: unknown) => void;
	const promise = new Promise<T>((nextResolve, nextReject) => {
		resolve = nextResolve;
		reject = nextReject;
	});
	return { promise, resolve, reject };
}

interface HookSnapshot {
	board: BoardData;
	boardProjectId: string | null;
	sessions: Record<string, RuntimeTaskSessionSummary>;
	isServedFromBoardCache: boolean;
	refreshProjectState: () => Promise<void>;
	resetProjectSyncState: (targetProjectId?: string | null) => void;
	setBoard: ReturnType<typeof useProjectSync>["setBoard"];
	flushBoardCommands: ReturnType<typeof useProjectSync>["flushBoardCommands"];
}

function assertSnapshot(snapshot: HookSnapshot | null, message: string): asserts snapshot is HookSnapshot {
	if (snapshot === null) {
		throw new Error(message);
	}
}

function HookHarness({
	currentProjectId = "project-a",
	streamedProjectState,
	hasReceivedSnapshot = true,
	isDocumentVisible = false,
	onSnapshot,
}: {
	currentProjectId?: string | null;
	streamedProjectState: RuntimeProjectStateResponse | null;
	hasReceivedSnapshot?: boolean;
	isDocumentVisible?: boolean;
	onSnapshot: (snapshot: HookSnapshot) => void;
}): null {
	const [projectBoardSessions, setProjectBoardSessionsState] = useState<ProjectBoardSessionsState>(() => ({
		board: createInitialBoardData(),
		sessions: {},
	}));
	const projectBoardSessionsRef = useRef(projectBoardSessions);
	const { board, sessions } = projectBoardSessions;

	const setProjectBoardSessions = useCallback(
		(nextState: ProjectBoardSessionsState | ((current: ProjectBoardSessionsState) => ProjectBoardSessionsState)) => {
			const resolved = typeof nextState === "function" ? nextState(projectBoardSessionsRef.current) : nextState;
			projectBoardSessionsRef.current = resolved;
			setProjectBoardSessionsState(resolved);
		},
		[],
	);
	const {
		boardProjectId,
		refreshProjectState,
		resetProjectSyncState,
		isServedFromBoardCache,
		setBoard,
		flushBoardCommands,
	} = useProjectSync({
		currentProjectId,
		streamedProjectState,
		hasNoProjects: false,
		hasReceivedSnapshot,
		isDocumentVisible,
		projectBoardSessionsRef,
		setProjectBoardSessions,
	});

	useEffect(() => {
		onSnapshot({
			board,
			boardProjectId,
			sessions,
			isServedFromBoardCache,
			refreshProjectState,
			resetProjectSyncState,
			setBoard,
			flushBoardCommands,
		});
	}, [
		board,
		boardProjectId,
		isServedFromBoardCache,
		onSnapshot,
		refreshProjectState,
		resetProjectSyncState,
		setBoard,
		flushBoardCommands,
		sessions,
	]);

	return null;
}

describe("useProjectSync", () => {
	let container: HTMLDivElement;
	let root: Root;
	let previousActEnvironment: boolean | undefined;

	beforeEach(() => {
		fetchProjectStateMock.mockReset();
		applyProjectBoardCommandsMock.mockReset();
		previousActEnvironment = (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean })
			.IS_REACT_ACT_ENVIRONMENT;
		(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
		container = document.createElement("div");
		document.body.appendChild(container);
		root = createRoot(container);
	});

	afterEach(() => {
		clearProjectBoardCache();
		act(() => {
			root.unmount();
		});
		container.remove();
		if (previousActEnvironment === undefined) {
			delete (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
		} else {
			(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
				previousActEnvironment;
		}
	});

	it("ignores a stale refresh response after the sync state is reset during a project transition", async () => {
		const deferred = createDeferred<RuntimeProjectStateResponse>();
		fetchProjectStateMock.mockReturnValue(deferred.promise);

		let latestSnapshot: HookSnapshot | null = null;
		let refreshPromise: Promise<void> | null = null;

		await act(async () => {
			root.render(
				<HookHarness
					streamedProjectState={createProjectState("persisted-task", 1)}
					onSnapshot={(snapshot) => {
						latestSnapshot = snapshot;
					}}
				/>,
			);
		});

		assertSnapshot(latestSnapshot, "Expected an initial hook snapshot.");
		const initialSnapshot: HookSnapshot = latestSnapshot;
		expect(initialSnapshot.board.columns[0]?.cards[0]?.id).toBe("persisted-task");
		expect(initialSnapshot.boardProjectId).toBe("project-a");

		await act(async () => {
			refreshPromise = initialSnapshot.refreshProjectState();
		});

		await act(async () => {
			initialSnapshot.resetProjectSyncState();
		});

		await act(async () => {
			deferred.resolve(createProjectState("stale-task", 1));
			await refreshPromise;
		});

		assertSnapshot(latestSnapshot, "Expected a hook snapshot.");
		const snapshot: HookSnapshot = latestSnapshot;
		expect(snapshot.board.columns[0]?.cards[0]?.id).toBe("persisted-task");
		expect(snapshot.board.columns[0]?.cards[0]?.id).not.toBe("stale-task");
	});

	it("clears board ownership while an uncached switch target loads", async () => {
		let latestSnapshot: HookSnapshot | null = null;

		await act(async () => {
			root.render(
				<HookHarness
					currentProjectId="project-a"
					streamedProjectState={createProjectState("persisted-task", 1)}
					onSnapshot={(snapshot) => {
						latestSnapshot = snapshot;
					}}
				/>,
			);
		});

		assertSnapshot(latestSnapshot, "Expected an initial hook snapshot.");
		const initialSnapshot: HookSnapshot = latestSnapshot;

		await act(async () => {
			initialSnapshot.resetProjectSyncState("project-b");
		});

		assertSnapshot(latestSnapshot, "Expected an uncached target snapshot.");
		const targetSnapshot: HookSnapshot = latestSnapshot;
		expect(targetSnapshot.board.columns.every((column) => column.cards.length === 0)).toBe(true);
		expect(targetSnapshot.boardProjectId).toBeNull();
		expect(targetSnapshot.isServedFromBoardCache).toBe(false);
	});

	it("keeps board ownership on the latest target across rapid switches and stale snapshots", async () => {
		for (const [projectId, taskId, revision] of [
			["project-b", "cached-b-task", 3],
			["project-c", "cached-c-task", 4],
		] as const) {
			stashProjectBoard(projectId, {
				board: createBoard(taskId),
				sessions: {},
				authoritativeRevision: revision,
				projectPath: `/tmp/${projectId}`,
				projectGit: {
					currentBranch: "main",
					defaultBranch: "main",
					branches: ["main"],
				},
			});
		}

		let latestSnapshot: HookSnapshot | null = null;
		const onSnapshot = (snapshot: HookSnapshot) => {
			latestSnapshot = snapshot;
		};

		await act(async () => {
			root.render(
				<HookHarness
					currentProjectId="project-a"
					streamedProjectState={createProjectState("persisted-task", 1)}
					onSnapshot={onSnapshot}
				/>,
			);
		});

		assertSnapshot(latestSnapshot, "Expected an initial hook snapshot.");
		const initialSnapshot: HookSnapshot = latestSnapshot;
		await act(async () => {
			initialSnapshot.resetProjectSyncState("project-b");
		});

		assertSnapshot(latestSnapshot, "Expected the first cached target snapshot.");
		const firstTargetSnapshot: HookSnapshot = latestSnapshot;
		expect(firstTargetSnapshot.board.columns[0]?.cards[0]?.id).toBe("cached-b-task");
		expect(firstTargetSnapshot.boardProjectId).toBe("project-b");

		await act(async () => {
			firstTargetSnapshot.resetProjectSyncState("project-c");
		});

		assertSnapshot(latestSnapshot, "Expected the latest cached target snapshot.");
		const latestTargetSnapshot: HookSnapshot = latestSnapshot;
		expect(latestTargetSnapshot.board.columns[0]?.cards[0]?.id).toBe("cached-c-task");
		expect(latestTargetSnapshot.boardProjectId).toBe("project-c");

		await act(async () => {
			root.render(
				<HookHarness
					currentProjectId="project-b"
					streamedProjectState={createProjectState("stale-b-task", 4)}
					onSnapshot={onSnapshot}
				/>,
			);
		});

		assertSnapshot(latestSnapshot, "Expected stale project B state to be ignored.");
		const staleSnapshot: HookSnapshot = latestSnapshot;
		expect(staleSnapshot.board.columns[0]?.cards[0]?.id).toBe("cached-c-task");
		expect(staleSnapshot.boardProjectId).toBe("project-c");

		await act(async () => {
			root.render(
				<HookHarness
					currentProjectId="project-c"
					streamedProjectState={{
						...createProjectState("authoritative-c-task", 4),
						repoPath: "/tmp/project-c",
						statePath: "/tmp/project-c/.quarterdeck",
					}}
					onSnapshot={onSnapshot}
				/>,
			);
		});

		assertSnapshot(latestSnapshot, "Expected the project C authoritative handoff.");
		const authoritativeSnapshot: HookSnapshot = latestSnapshot;
		expect(authoritativeSnapshot.board.columns[0]?.cards[0]?.id).toBe("cached-c-task");
		expect(authoritativeSnapshot.boardProjectId).toBe("project-c");
		expect(authoritativeSnapshot.isServedFromBoardCache).toBe(false);
	});

	it("treats a restored cached board as non-authoritative until matching project state arrives", async () => {
		stashProjectBoard("project-b", {
			board: createBoard("cached-task"),
			sessions: {},
			authoritativeRevision: 3,
			projectPath: "/tmp/project-b",
			projectGit: {
				currentBranch: "main",
				defaultBranch: "main",
				branches: ["main"],
			},
		});

		let latestSnapshot: HookSnapshot | null = null;

		await act(async () => {
			root.render(
				<HookHarness
					currentProjectId="project-a"
					streamedProjectState={createProjectState("persisted-task", 1)}
					onSnapshot={(snapshot) => {
						latestSnapshot = snapshot;
					}}
				/>,
			);
		});

		assertSnapshot(latestSnapshot, "Expected an initial hook snapshot.");
		const initialSnapshot: HookSnapshot = latestSnapshot;

		await act(async () => {
			initialSnapshot.resetProjectSyncState("project-b");
		});

		assertSnapshot(latestSnapshot, "Expected a cached hook snapshot.");
		const cachedSnapshot: HookSnapshot = latestSnapshot;
		expect(cachedSnapshot.board.columns[0]?.cards[0]?.id).toBe("cached-task");
		expect(cachedSnapshot.boardProjectId).toBe("project-b");
		expect(cachedSnapshot.isServedFromBoardCache).toBe(true);

		await act(async () => {
			root.render(
				<HookHarness
					currentProjectId="project-b"
					streamedProjectState={{
						...createProjectState("authoritative-task", 3),
						repoPath: "/tmp/project-b",
						statePath: "/tmp/project-b/.quarterdeck",
					}}
					onSnapshot={(snapshot) => {
						latestSnapshot = snapshot;
					}}
				/>,
			);
		});

		assertSnapshot(latestSnapshot, "Expected an authoritative hook snapshot.");
		const authoritativeSnapshot: HookSnapshot = latestSnapshot;
		expect(authoritativeSnapshot.board.columns[0]?.cards[0]?.id).toBe("cached-task");
		expect(authoritativeSnapshot.boardProjectId).toBe("project-b");
		expect(authoritativeSnapshot.isServedFromBoardCache).toBe(false);
	});

	it("keeps a restored cached board stable when only same-revision session data changes", async () => {
		stashProjectBoard("project-b", {
			board: createBoardInColumn("in_progress", "task-1"),
			sessions: {
				"task-1": createSessionSummary("task-1", 1000, null),
			},
			authoritativeRevision: 3,
			projectPath: "/tmp/project-b",
			projectGit: {
				currentBranch: "main",
				defaultBranch: "main",
				branches: ["main"],
			},
		});

		let latestSnapshot: HookSnapshot | null = null;

		await act(async () => {
			root.render(
				<HookHarness
					currentProjectId="project-a"
					streamedProjectState={createProjectState("persisted-task", 1)}
					onSnapshot={(snapshot) => {
						latestSnapshot = snapshot;
					}}
				/>,
			);
		});

		assertSnapshot(latestSnapshot, "Expected an initial hook snapshot.");
		const initialSnapshot: HookSnapshot = latestSnapshot;

		await act(async () => {
			initialSnapshot.resetProjectSyncState("project-b");
		});

		assertSnapshot(latestSnapshot, "Expected a cached hook snapshot.");
		const cachedSnapshot: HookSnapshot = latestSnapshot;
		expect(cachedSnapshot.board.columns.find((column) => column.id === "in_progress")?.cards[0]?.id).toBe("task-1");

		await act(async () => {
			root.render(
				<HookHarness
					currentProjectId="project-b"
					streamedProjectState={{
						...createProjectState("task-1", 3),
						repoPath: "/tmp/project-b",
						statePath: "/tmp/project-b/.quarterdeck",
						board: createBoardInColumn("in_progress", "task-1"),
						sessions: {
							"task-1": createSessionSummary("task-1", 2000, "Ready for review"),
						},
					}}
					onSnapshot={(snapshot) => {
						latestSnapshot = snapshot;
					}}
				/>,
			);
		});

		assertSnapshot(latestSnapshot, "Expected an authoritative hook snapshot.");
		const authoritativeSnapshot: HookSnapshot = latestSnapshot;
		expect(authoritativeSnapshot.board.columns.find((column) => column.id === "in_progress")?.cards[0]?.id).toBe(
			"task-1",
		);
		expect(authoritativeSnapshot.board.columns.find((column) => column.id === "review")?.cards).toHaveLength(0);
	});

	it("ignores streamed project state for the previous project after a switch reset targets a new project", async () => {
		stashProjectBoard("project-b", {
			board: createBoard("cached-task"),
			sessions: {},
			authoritativeRevision: 2,
			projectPath: "/tmp/project-b",
			projectGit: {
				currentBranch: "main",
				defaultBranch: "main",
				branches: ["main"],
			},
		});

		let latestSnapshot: HookSnapshot | null = null;

		await act(async () => {
			root.render(
				<HookHarness
					currentProjectId="project-a"
					streamedProjectState={createProjectState("persisted-task", 1)}
					onSnapshot={(snapshot) => {
						latestSnapshot = snapshot;
					}}
				/>,
			);
		});

		assertSnapshot(latestSnapshot, "Expected an initial hook snapshot.");
		const initialSnapshot: HookSnapshot = latestSnapshot;

		await act(async () => {
			initialSnapshot.resetProjectSyncState("project-b");
		});

		await act(async () => {
			root.render(
				<HookHarness
					currentProjectId="project-a"
					streamedProjectState={createProjectState("stale-project-a-task", 2)}
					onSnapshot={(snapshot) => {
						latestSnapshot = snapshot;
					}}
				/>,
			);
		});

		assertSnapshot(latestSnapshot, "Expected a cached hook snapshot after stale rerender.");
		const snapshot: HookSnapshot = latestSnapshot;
		expect(snapshot.board.columns[0]?.cards[0]?.id).toBe("cached-task");
		expect(snapshot.board.columns[0]?.cards[0]?.id).not.toBe("stale-project-a-task");
	});

	it("clears task sessions missing from refreshed authoritative project state", async () => {
		const existingSummary = createSessionSummary("task-1", 1000, "All done");
		fetchProjectStateMock.mockResolvedValue(createProjectState("persisted-task", 2));

		let latestSnapshot: HookSnapshot | null = null;

		await act(async () => {
			root.render(
				<HookHarness
					streamedProjectState={createProjectStateWithSessions("persisted-task", 1, {
						"task-1": existingSummary,
					})}
					onSnapshot={(snapshot) => {
						latestSnapshot = snapshot;
					}}
				/>,
			);
		});

		assertSnapshot(latestSnapshot, "Expected an initial hook snapshot.");
		const initialSnapshot: HookSnapshot = latestSnapshot;
		expect(initialSnapshot.sessions["task-1"]?.latestHookActivity?.finalMessage).toBe("All done");

		await act(async () => {
			await initialSnapshot.refreshProjectState();
		});

		assertSnapshot(latestSnapshot, "Expected a hook snapshot after refresh.");
		const refreshedSnapshot: HookSnapshot = latestSnapshot;
		expect(refreshedSnapshot.sessions["task-1"]).toBeUndefined();
	});

	it("drops cached-restore session entries once authoritative project state arrives without them", async () => {
		stashProjectBoard("project-b", {
			board: createBoard("cached-task"),
			sessions: {
				"task-1": createSessionSummary("task-1", 1000, "Cached review"),
			},
			authoritativeRevision: 3,
			projectPath: "/tmp/project-b",
			projectGit: {
				currentBranch: "main",
				defaultBranch: "main",
				branches: ["main"],
			},
		});

		let latestSnapshot: HookSnapshot | null = null;

		await act(async () => {
			root.render(
				<HookHarness
					currentProjectId="project-a"
					streamedProjectState={createProjectState("persisted-task", 1)}
					onSnapshot={(snapshot) => {
						latestSnapshot = snapshot;
					}}
				/>,
			);
		});

		assertSnapshot(latestSnapshot, "Expected an initial hook snapshot.");
		const initialSnapshot: HookSnapshot = latestSnapshot;

		await act(async () => {
			initialSnapshot.resetProjectSyncState("project-b");
		});

		assertSnapshot(latestSnapshot, "Expected a cached hook snapshot.");
		const cachedSnapshot: HookSnapshot = latestSnapshot;
		expect(cachedSnapshot.sessions["task-1"]?.latestHookActivity?.finalMessage).toBe("Cached review");

		await act(async () => {
			root.render(
				<HookHarness
					currentProjectId="project-b"
					streamedProjectState={{
						...createProjectState("authoritative-task", 3),
						repoPath: "/tmp/project-b",
						statePath: "/tmp/project-b/.quarterdeck",
					}}
					onSnapshot={(snapshot) => {
						latestSnapshot = snapshot;
					}}
				/>,
			);
		});

		assertSnapshot(latestSnapshot, "Expected an authoritative hook snapshot.");
		const authoritativeSnapshot: HookSnapshot = latestSnapshot;
		expect(authoritativeSnapshot.sessions["task-1"]).toBeUndefined();
	});

	it("keeps session reconciliation monotonic without overriding the newer runtime board", async () => {
		const newerReviewSummary = createSessionSummary("task-1", 2000, "Ready for review");
		const staleRunningSummary = createSessionSummary("task-1", 1000, null);

		let latestSnapshot: HookSnapshot | null = null;

		await act(async () => {
			root.render(
				<HookHarness
					streamedProjectState={{
						...createProjectStateWithSessions("task-1", 1, {
							"task-1": newerReviewSummary,
						}),
						board: createBoardInColumn("review", "task-1"),
					}}
					onSnapshot={(snapshot) => {
						latestSnapshot = snapshot;
					}}
				/>,
			);
		});

		assertSnapshot(latestSnapshot, "Expected an initial hook snapshot.");
		const initialSnapshot: HookSnapshot = latestSnapshot;
		expect(initialSnapshot.sessions["task-1"]?.updatedAt).toBe(2000);
		expect(initialSnapshot.sessions["task-1"]?.state).toBe("awaiting_review");
		expect(initialSnapshot.board.columns.find((column) => column.id === "review")?.cards[0]?.id).toBe("task-1");

		await act(async () => {
			root.render(
				<HookHarness
					streamedProjectState={{
						...createProjectStateWithSessions("task-1", 2, {
							"task-1": staleRunningSummary,
						}),
						board: createBoardInColumn("in_progress", "task-1"),
					}}
					onSnapshot={(snapshot) => {
						latestSnapshot = snapshot;
					}}
				/>,
			);
		});

		assertSnapshot(latestSnapshot, "Expected a hook snapshot after rerender.");
		const rerenderedSnapshot: HookSnapshot = latestSnapshot;
		expect(rerenderedSnapshot.sessions["task-1"]?.updatedAt).toBe(2000);
		expect(rerenderedSnapshot.sessions["task-1"]?.state).toBe("awaiting_review");
		expect(rerenderedSnapshot.board.columns.find((column) => column.id === "in_progress")?.cards[0]?.id).toBe(
			"task-1",
		);
		expect(rerenderedSnapshot.board.columns.find((column) => column.id === "review")?.cards).toHaveLength(0);
	});

	it("does not refresh project state before the initial runtime snapshot resolves", async () => {
		let latestSnapshot: HookSnapshot | null = null;

		await act(async () => {
			root.render(
				<HookHarness
					streamedProjectState={null}
					hasReceivedSnapshot={false}
					isDocumentVisible={true}
					onSnapshot={(snapshot) => {
						latestSnapshot = snapshot;
					}}
				/>,
			);
		});

		expect(fetchProjectStateMock).not.toHaveBeenCalled();
		expect(latestSnapshot).not.toBeNull();
	});

	it("does not retry project state refresh when the runtime snapshot has no project state", async () => {
		let latestSnapshot: HookSnapshot | null = null;

		await act(async () => {
			root.render(
				<HookHarness
					streamedProjectState={null}
					hasReceivedSnapshot={true}
					isDocumentVisible={true}
					onSnapshot={(snapshot) => {
						latestSnapshot = snapshot;
					}}
				/>,
			);
		});

		expect(fetchProjectStateMock).not.toHaveBeenCalled();
		expect(latestSnapshot).not.toBeNull();
	});

	it("accepts runtime-owned work-column placement during authoritative hydrate", async () => {
		let latestSnapshot: HookSnapshot | null = null;

		await act(async () => {
			root.render(
				<HookHarness
					streamedProjectState={{
						...createProjectState("task-1", 1),
						board: createBoardInColumn("in_progress", "task-1"),
						sessions: {
							"task-1": createSessionSummary("task-1", 1000, "Ready for review"),
						},
					}}
					onSnapshot={(snapshot) => {
						latestSnapshot = snapshot;
					}}
				/>,
			);
		});

		assertSnapshot(latestSnapshot, "Expected a projected hook snapshot.");
		const snapshot: HookSnapshot = latestSnapshot;
		expect(snapshot.board.columns.find((column) => column.id === "in_progress")?.cards[0]?.id).toBe("task-1");
		expect(snapshot.board.columns.find((column) => column.id === "review")?.cards).toHaveLength(0);
	});

	it("renders optimistically, commits an explicit command batch, and flushes the result", async () => {
		const committed = createProjectState("persisted-task", 2);
		committed.board = createBoardInColumn("in_progress", "persisted-task");
		const commandResult = createDeferred<{
			state: RuntimeProjectStateResponse;
			changed: boolean;
			acceptedChange: boolean;
			replayed: boolean;
		}>();
		applyProjectBoardCommandsMock.mockReturnValue(commandResult.promise);
		let latestSnapshot: HookSnapshot | null = null;

		await act(async () => {
			root.render(
				<HookHarness
					streamedProjectState={createProjectState("persisted-task", 1)}
					onSnapshot={(snapshot) => {
						latestSnapshot = snapshot;
					}}
				/>,
			);
		});

		assertSnapshot(latestSnapshot, "Expected an initial hook snapshot.");
		const initialSnapshot: HookSnapshot = latestSnapshot;
		let flushPromise: Promise<{ ok: boolean; message?: string }> | null = null;
		await act(async () => {
			initialSnapshot.setBoard(createBoardInColumn("in_progress", "persisted-task"));
			flushPromise = initialSnapshot.flushBoardCommands();
		});

		const optimisticSnapshot = latestSnapshot as HookSnapshot | null;
		assertSnapshot(optimisticSnapshot, "Expected an optimistic hook snapshot.");
		expect(optimisticSnapshot.board.columns.find((column) => column.id === "in_progress")?.cards[0]?.id).toBe(
			"persisted-task",
		);
		expect(applyProjectBoardCommandsMock).toHaveBeenCalledWith(
			"project-a",
			expect.objectContaining({
				expectedRevision: 1,
				commandId: expect.stringMatching(/^browser:/),
				commands: [
					expect.objectContaining({
						kind: "move_task",
						taskId: "persisted-task",
						sourceColumnId: "backlog",
						targetColumnId: "in_progress",
					}),
				],
			}),
		);

		commandResult.resolve({ state: committed, changed: true, acceptedChange: true, replayed: false });
		const pendingFlush = flushPromise as Promise<{ ok: boolean; message?: string }> | null;
		if (!pendingFlush) throw new Error("Expected a pending board command flush.");
		await act(async () => {
			await pendingFlush;
		});
		expect(await pendingFlush).toEqual({ ok: true });
	});

	it("never caches an optimistic overlay as authoritative during a project switch", async () => {
		const committed = createProjectState("persisted-task", 2);
		committed.board = createBoardInColumn("in_progress", "persisted-task");
		const commandResult = createDeferred<{
			state: RuntimeProjectStateResponse;
			changed: boolean;
			acceptedChange: boolean;
			replayed: boolean;
		}>();
		applyProjectBoardCommandsMock.mockReturnValue(commandResult.promise);
		let latestSnapshot: HookSnapshot | null = null;

		await act(async () => {
			root.render(
				<HookHarness
					streamedProjectState={createProjectState("persisted-task", 1)}
					onSnapshot={(snapshot) => {
						latestSnapshot = snapshot;
					}}
				/>,
			);
		});

		assertSnapshot(latestSnapshot, "Expected an initial hook snapshot.");
		const initialSnapshot: HookSnapshot = latestSnapshot;
		await act(async () => {
			initialSnapshot.setBoard(createBoardInColumn("in_progress", "persisted-task"));
		});
		assertSnapshot(latestSnapshot, "Expected an optimistic hook snapshot.");
		const optimisticSnapshot: HookSnapshot = latestSnapshot;
		await act(async () => {
			optimisticSnapshot.resetProjectSyncState("project-b");
		});

		const cachedBeforeCommit = restoreProjectBoard("project-a");
		expect(cachedBeforeCommit?.authoritativeRevision).toBe(1);
		expect(cachedBeforeCommit?.board.columns.find((column) => column.id === "backlog")?.cards[0]?.id).toBe(
			"persisted-task",
		);
		expect(cachedBeforeCommit?.board.columns.find((column) => column.id === "in_progress")?.cards).toHaveLength(0);

		commandResult.resolve({ state: committed, changed: true, acceptedChange: true, replayed: false });
		await vi.waitFor(() => {
			const cachedAfterCommit = restoreProjectBoard("project-a");
			expect(cachedAfterCommit?.authoritativeRevision).toBe(2);
			expect(cachedAfterCommit?.board.columns.find((column) => column.id === "in_progress")?.cards[0]?.id).toBe(
				"persisted-task",
			);
		});
	});

	it("restores authoritative state and rebases the queue after a revision conflict", async () => {
		const refresh = createDeferred<RuntimeProjectStateResponse>();
		fetchProjectStateMock.mockReturnValue(refresh.promise);
		applyProjectBoardCommandsMock.mockRejectedValue(new ProjectStateConflictError(2));
		let latestSnapshot: HookSnapshot | null = null;

		await act(async () => {
			root.render(
				<HookHarness
					streamedProjectState={createProjectState("persisted-task", 1)}
					onSnapshot={(snapshot) => {
						latestSnapshot = snapshot;
					}}
				/>,
			);
		});

		assertSnapshot(latestSnapshot, "Expected an initial hook snapshot.");
		const initialSnapshot: HookSnapshot = latestSnapshot;
		let flushPromise: Promise<{ ok: boolean; message?: string }> | null = null;
		await act(async () => {
			initialSnapshot.setBoard(createBoardInColumn("in_progress", "persisted-task"));
			flushPromise = initialSnapshot.flushBoardCommands();
			await Promise.resolve();
		});

		await vi.waitFor(() => {
			assertSnapshot(latestSnapshot, "Expected a restored hook snapshot.");
			expect(latestSnapshot.board.columns[0]?.cards[0]?.id).toBe("persisted-task");
		});

		refresh.resolve(createProjectState("remote-task", 2));
		const pendingFlush = flushPromise as Promise<{ ok: boolean; message?: string }> | null;
		if (!pendingFlush) throw new Error("Expected a pending board command flush.");
		await act(async () => {
			await pendingFlush;
		});
		expect(await pendingFlush).toMatchObject({ ok: false });
		const refreshedSnapshot = latestSnapshot as HookSnapshot | null;
		assertSnapshot(refreshedSnapshot, "Expected a refreshed hook snapshot.");
		expect(refreshedSnapshot.board.columns[0]?.cards[0]?.id).toBe("remote-task");

		applyProjectBoardCommandsMock.mockResolvedValue({
			state: createProjectState("remote-task", 3),
			changed: false,
			acceptedChange: false,
			replayed: false,
		});
		await act(async () => {
			refreshedSnapshot.setBoard(createBoardInColumn("in_progress", "remote-task"));
			await refreshedSnapshot.flushBoardCommands();
		});
		expect(applyProjectBoardCommandsMock).toHaveBeenLastCalledWith(
			"project-a",
			expect.objectContaining({ expectedRevision: 2 }),
		);
	});

	it("retries an ambiguous transport failure with the same durable command identity", async () => {
		const committed = createProjectState("persisted-task", 2);
		committed.board = createBoardInColumn("in_progress", "persisted-task");
		applyProjectBoardCommandsMock
			.mockRejectedValueOnce(new Error("response lost"))
			.mockResolvedValueOnce({ state: committed, changed: false, acceptedChange: true, replayed: true });
		let latestSnapshot: HookSnapshot | null = null;

		await act(async () => {
			root.render(
				<HookHarness
					streamedProjectState={createProjectState("persisted-task", 1)}
					onSnapshot={(snapshot) => {
						latestSnapshot = snapshot;
					}}
				/>,
			);
		});

		assertSnapshot(latestSnapshot, "Expected an initial hook snapshot.");
		const initialSnapshot: HookSnapshot = latestSnapshot;
		await act(async () => {
			initialSnapshot.setBoard(createBoardInColumn("in_progress", "persisted-task"));
			await initialSnapshot.flushBoardCommands();
		});

		expect(applyProjectBoardCommandsMock).toHaveBeenCalledTimes(2);
		expect(applyProjectBoardCommandsMock.mock.calls[1]).toEqual(applyProjectBoardCommandsMock.mock.calls[0]);
	});
});
