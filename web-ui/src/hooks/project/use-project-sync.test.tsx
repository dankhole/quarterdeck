import { act, useEffect, useRef, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createInitialBoardData } from "@/data/board-data";
import { useProjectSync } from "@/hooks/project/use-project-sync";
import { clearProjectBoardCache, stashProjectBoard } from "@/runtime/project-board-cache";
import type { RuntimeProjectStateResponse, RuntimeTaskSessionSummary } from "@/runtime/types";
import type { BoardData } from "@/types";

const fetchProjectStateMock = vi.hoisted(() => vi.fn());

vi.mock("@/runtime/project-state-query", () => ({
	fetchProjectState: fetchProjectStateMock,
}));

function createBoard(taskId: string): BoardData {
	return {
		columns: [
			{
				id: "backlog",
				title: "Backlog",
				cards: [
					{
						id: taskId,
						title: null,
						prompt: `Prompt ${taskId}`,
						startInPlanMode: false,
						autoReviewEnabled: false,
						autoReviewMode: "commit",
						baseRef: "main",
						createdAt: 1,
						updatedAt: 1,
					},
				],
			},
			{ id: "in_progress", title: "In Progress", cards: [] },
			{ id: "review", title: "Review", cards: [] },
			{ id: "trash", title: "Trash", cards: [] },
		],
		dependencies: [],
	};
}

function createProjectState(taskId: string, revision: number): RuntimeProjectStateResponse {
	return {
		repoPath: "/tmp/project-a",
		statePath: "/tmp/project-a/.quarterdeck",
		git: {
			currentBranch: "main",
			defaultBranch: "main",
			branches: ["main"],
		},
		board: createBoard(taskId),
		sessions: {},
		revision,
	};
}

function createSessionSummary(
	taskId: string,
	updatedAt: number,
	finalMessage: string | null,
): RuntimeTaskSessionSummary {
	return {
		taskId,
		state: finalMessage ? "awaiting_review" : "running",
		agentId: "claude",
		projectPath: "/tmp/project-a",
		pid: null,
		startedAt: updatedAt - 100,
		updatedAt,
		lastOutputAt: updatedAt,
		reviewReason: finalMessage ? "hook" : null,
		exitCode: null,
		lastHookAt: updatedAt,
		latestHookActivity: finalMessage
			? {
					activityText: `Final: ${finalMessage}`,
					toolName: null,
					toolInputSummary: null,
					finalMessage,
					hookEventName: "agent_end",
					notificationType: null,
					conversationSummaryText: null,
					source: "hook",
				}
			: null,
		stalledSince: null,
		latestTurnCheckpoint: null,
		previousTurnCheckpoint: null,
		conversationSummaries: [],
		displaySummary: null,
		displaySummaryGeneratedAt: null,
	};
}

function createProjectStateWithSessions(
	taskId: string,
	revision: number,
	sessions: Record<string, RuntimeTaskSessionSummary>,
): RuntimeProjectStateResponse {
	return {
		...createProjectState(taskId, revision),
		sessions,
	};
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
	sessions: Record<string, RuntimeTaskSessionSummary>;
	canPersistProjectState: boolean;
	projectRevision: number | null;
	isServedFromBoardCache: boolean;
	refreshProjectState: () => Promise<void>;
	resetProjectSyncState: (targetProjectId?: string | null) => void;
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
	const [board, setBoard] = useState<BoardData>(() => createInitialBoardData());
	const [sessions, setSessions] = useState<Record<string, RuntimeTaskSessionSummary>>({});
	const [canPersistProjectState, setCanPersistProjectState] = useState(false);
	const boardRef = useRef(board);
	boardRef.current = board;
	const sessionsRef = useRef(sessions);
	sessionsRef.current = sessions;
	const { refreshProjectState, resetProjectSyncState, projectRevision, isServedFromBoardCache } = useProjectSync({
		currentProjectId,
		streamedProjectState,
		hasNoProjects: false,
		hasReceivedSnapshot,
		isDocumentVisible,
		boardRef,
		sessionsRef,
		setBoard,
		setSessions,
		setCanPersistProjectState,
	});

	useEffect(() => {
		onSnapshot({
			board,
			sessions,
			canPersistProjectState,
			projectRevision,
			isServedFromBoardCache,
			refreshProjectState,
			resetProjectSyncState,
		});
	}, [
		board,
		canPersistProjectState,
		isServedFromBoardCache,
		onSnapshot,
		projectRevision,
		refreshProjectState,
		resetProjectSyncState,
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
		expect(initialSnapshot.canPersistProjectState).toBe(true);

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
		expect(cachedSnapshot.canPersistProjectState).toBe(false);
		expect(cachedSnapshot.projectRevision).toBeNull();
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
		expect(authoritativeSnapshot.canPersistProjectState).toBe(true);
		expect(authoritativeSnapshot.projectRevision).toBe(3);
		expect(authoritativeSnapshot.isServedFromBoardCache).toBe(false);
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
		expect(snapshot.canPersistProjectState).toBe(false);
	});

	it("preserves newer in-memory task session summaries when refreshed project state lacks them", async () => {
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
		expect(refreshedSnapshot.sessions["task-1"]?.latestHookActivity?.finalMessage).toBe("All done");
	});

	it("does not let an older streamed session summary overwrite a newer in-memory one", async () => {
		const newerRunningSummary = createSessionSummary("task-1", 2000, null);
		const staleInterruptedSummary = createSessionSummary("task-1", 1000, "Stale output");

		let latestSnapshot: HookSnapshot | null = null;

		await act(async () => {
			root.render(
				<HookHarness
					streamedProjectState={createProjectStateWithSessions("persisted-task", 1, {
						"task-1": newerRunningSummary,
					})}
					onSnapshot={(snapshot) => {
						latestSnapshot = snapshot;
					}}
				/>,
			);
		});

		assertSnapshot(latestSnapshot, "Expected an initial hook snapshot.");
		const initialSnapshot: HookSnapshot = latestSnapshot;
		expect(initialSnapshot.sessions["task-1"]?.updatedAt).toBe(2000);
		expect(initialSnapshot.sessions["task-1"]?.state).toBe("running");

		await act(async () => {
			root.render(
				<HookHarness
					streamedProjectState={createProjectStateWithSessions("persisted-task", 2, {
						"task-1": staleInterruptedSummary,
					})}
					onSnapshot={(snapshot) => {
						latestSnapshot = snapshot;
					}}
				/>,
			);
		});

		assertSnapshot(latestSnapshot, "Expected a hook snapshot after rerender.");
		const rerenderedSnapshot: HookSnapshot = latestSnapshot;
		expect(rerenderedSnapshot.sessions["task-1"]?.updatedAt).toBe(2000);
		expect(rerenderedSnapshot.sessions["task-1"]?.state).toBe("running");
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
});
