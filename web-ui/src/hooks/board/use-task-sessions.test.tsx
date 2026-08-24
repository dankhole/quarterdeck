import { act, useEffect, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { useTaskSessions } from "@/hooks/board/use-task-sessions";
import type { RuntimeTaskSessionSummary } from "@/runtime/types";
import { createTestTaskSessionSummary } from "@/test-utils/task-session-factory";
import type { BoardCard } from "@/types";

const sendTaskSessionInputMutateMock = vi.hoisted(() => vi.fn());
const getTaskContextQueryMock = vi.hoisted(() => vi.fn());
const getTerminalControllerMock = vi.hoisted(() => vi.fn());
const notifyErrorMock = vi.hoisted(() => vi.fn());
const showAppToastMock = vi.hoisted(() => vi.fn());

vi.mock("@/runtime/trpc-client", () => ({
	getRuntimeTrpcClient: () => ({
		project: { getTaskContext: { query: getTaskContextQueryMock } },
		runtime: { sendTaskSessionInput: { mutate: sendTaskSessionInputMutateMock } },
	}),
}));

vi.mock("@/terminal/terminal-controller-registry", () => ({
	getTerminalController: getTerminalControllerMock,
}));

vi.mock("@/components/app-toaster", () => ({
	notifyError: notifyErrorMock,
	showAppToast: showAppToastMock,
}));

interface HookSnapshot {
	sessions: Record<string, RuntimeTaskSessionSummary>;
	upsertSession: ReturnType<typeof useTaskSessions>["upsertSession"];
	sendTaskSessionInput: ReturnType<typeof useTaskSessions>["sendTaskSessionInput"];
	fetchTaskWorktreeInfo: ReturnType<typeof useTaskSessions>["fetchTaskWorktreeInfo"];
}

function HookHarness({
	currentProjectId = "project-1",
	onSnapshot,
}: {
	currentProjectId?: string | null;
	onSnapshot: (snapshot: HookSnapshot) => void;
}): null {
	const [sessions, setSessions] = useState<Record<string, RuntimeTaskSessionSummary>>({});
	const actions = useTaskSessions({ currentProjectId, setSessions });

	useEffect(() => {
		onSnapshot({ sessions, ...actions });
	}, [actions, onSnapshot, sessions]);
	return null;
}

function createSummary(updatedAt: number, warningMessage?: string): RuntimeTaskSessionSummary {
	return createTestTaskSessionSummary({
		taskId: "task-1",
		state: "running",
		agentId: "codex",
		sessionLaunchPath: "/tmp/task-1",
		startedAt: updatedAt,
		updatedAt,
		pid: updatedAt,
		warningMessage,
	});
}

function createTask(): BoardCard {
	return {
		id: "task-1",
		title: null,
		prompt: "Continue",
		baseRef: "main",
		createdAt: 1,
		updatedAt: 1,
	};
}

function requireSnapshot(snapshot: HookSnapshot | null): HookSnapshot {
	if (!snapshot) {
		throw new Error("Expected a hook snapshot.");
	}
	return snapshot;
}

describe("useTaskSessions", () => {
	let container: HTMLDivElement;
	let root: Root;
	let latestSnapshot: HookSnapshot | null;
	let previousActEnvironment: boolean | undefined;

	beforeEach(async () => {
		sendTaskSessionInputMutateMock.mockReset();
		getTaskContextQueryMock.mockReset();
		getTerminalControllerMock.mockReset();
		notifyErrorMock.mockReset();
		showAppToastMock.mockReset();
		getTerminalControllerMock.mockReturnValue(null);
		latestSnapshot = null;
		previousActEnvironment = (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean })
			.IS_REACT_ACT_ENVIRONMENT;
		(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
		container = document.createElement("div");
		document.body.appendChild(container);
		root = createRoot(container);
		await act(async () => {
			root.render(
				<HookHarness
					onSnapshot={(snapshot) => {
						latestSnapshot = snapshot;
					}}
				/>,
			);
		});
	});

	afterEach(() => {
		act(() => root.unmount());
		container.remove();
		if (previousActEnvironment === undefined) {
			delete (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
		} else {
			(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
				previousActEnvironment;
		}
	});

	it("keeps the newest session summary and surfaces a new warning once", async () => {
		await act(async () => {
			requireSnapshot(latestSnapshot).upsertSession(createSummary(20, "Best-effort resume"));
			requireSnapshot(latestSnapshot).upsertSession(createSummary(10));
		});

		expect(requireSnapshot(latestSnapshot).sessions["task-1"]?.updatedAt).toBe(20);
		expect(showAppToastMock).toHaveBeenCalledOnce();
	});

	it("uses an attached terminal controller for low-latency input", async () => {
		const input = vi.fn(() => true);
		getTerminalControllerMock.mockReturnValue({ input, paste: vi.fn(() => true) });

		await expect(
			requireSnapshot(latestSnapshot).sendTaskSessionInput("task-1", "hello", { intent: "submit" }),
		).resolves.toEqual({ ok: true });

		expect(input).toHaveBeenNthCalledWith(1, "hello");
		expect(input).toHaveBeenNthCalledWith(2, "\r");
		expect(sendTaskSessionInputMutateMock).not.toHaveBeenCalled();
	});

	it("falls back to the runtime input API and merges its returned summary", async () => {
		const summary = createSummary(30);
		sendTaskSessionInputMutateMock.mockResolvedValue({ ok: true, summary });

		await act(async () => {
			await requireSnapshot(latestSnapshot).sendTaskSessionInput("task-1", "remote", {
				intent: "write",
				preferTerminal: false,
				appendNewline: false,
			});
		});

		expect(sendTaskSessionInputMutateMock).toHaveBeenCalledWith({
			taskId: "task-1",
			text: "remote",
			appendNewline: false,
			intent: "write",
		});
		expect(requireSnapshot(latestSnapshot).sessions["task-1"]).toEqual(summary);
	});

	it("preserves explicit provider-neutral submission intent", async () => {
		const summary = createSummary(31);
		sendTaskSessionInputMutateMock.mockResolvedValue({ ok: true, summary });

		await act(async () => {
			await requireSnapshot(latestSnapshot).sendTaskSessionInput("task-1", "remote response", {
				intent: "submit",
				preferTerminal: false,
			});
		});

		expect(sendTaskSessionInputMutateMock).toHaveBeenCalledWith({
			taskId: "task-1",
			text: "remote response",
			appendNewline: true,
			intent: "submit",
		});
	});

	it("reads task context without exposing lifecycle mutation methods", async () => {
		const response = { ok: true, taskId: "task-1", path: "/tmp/task-1" };
		getTaskContextQueryMock.mockResolvedValue(response);

		await expect(requireSnapshot(latestSnapshot).fetchTaskWorktreeInfo(createTask())).resolves.toBe(response);
		expect(getTaskContextQueryMock).toHaveBeenCalledWith({ taskId: "task-1", baseRef: "main" });
	});
});
