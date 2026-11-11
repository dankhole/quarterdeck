import { act, useEffect, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { useTaskSessions } from "@/hooks/board/use-task-sessions";
import { type UseTerminalPanelsResult, useTerminalPanels } from "@/hooks/terminal/use-terminal-panels";
import type { RuntimeTaskSessionSummary } from "@/runtime/types";
import { LocalStorageKey } from "@/storage/local-storage-store";
import { createTestTaskSessionSummary } from "@/test-utils/task-session-factory";
import type { CardSelection } from "@/types";

const mocks = vi.hoisted(() => ({
	start: vi.fn(),
	stop: vi.fn(),
	client: vi.fn(),
	dispose: vi.fn(),
	write: vi.fn(),
	notify: vi.fn(),
	controller: vi.fn(),
	waitForController: vi.fn(),
	geometry: vi.fn(),
	waitForGeometry: vi.fn(),
}));
vi.mock("@/runtime/trpc-client", () => ({ getRuntimeTrpcClient: mocks.client }));
vi.mock("@/components/app-toaster", () => ({ notifyError: mocks.notify }));
vi.mock("@/terminal/terminal-pool", () => ({
	disposeDedicatedTerminal: mocks.dispose,
	writeToTerminalBuffer: mocks.write,
}));
vi.mock("@/terminal/terminal-controller-registry", () => ({
	getTerminalController: mocks.controller,
	getTerminalControllerAttachment: mocks.controller,
	waitForTerminalController: mocks.waitForController,
}));
vi.mock("@/terminal/terminal-geometry-registry", () => ({
	getTerminalGeometry: mocks.geometry,
	prepareWaitForTerminalGeometry: () => mocks.waitForGeometry,
}));

interface HookSnapshot extends UseTerminalPanelsResult {
	sessions: Record<string, RuntimeTaskSessionSummary>;
}

function createSelection(taskId: string): CardSelection {
	const card = { id: taskId, title: null, prompt: `Task ${taskId}`, baseRef: "main", createdAt: 1, updatedAt: 1 };
	const column = { id: "in_progress" as const, title: "In Progress", cards: [card] };
	return { card, column, allColumns: [column] };
}

function createSummary(taskId: string, overrides: Partial<RuntimeTaskSessionSummary> = {}): RuntimeTaskSessionSummary {
	return createTestTaskSessionSummary({
		taskId,
		state: "running",
		agentId: null,
		sessionInstanceId: `${taskId}:instance`,
		sessionLaunchPath: `/tmp/${taskId}`,
		pid: 123,
		startedAt: 1,
		updatedAt: 1,
		...overrides,
	});
}

function deferred<T>() {
	let resolve!: (value: T) => void;
	let reject!: (error: Error) => void;
	const promise = new Promise<T>((resolvePromise, rejectPromise) => {
		resolve = resolvePromise;
		reject = rejectPromise;
	});
	return { promise, resolve, reject };
}

async function flushPromises(): Promise<void> {
	for (let index = 0; index < 12; index += 1) await Promise.resolve();
}

function HookHarness({
	currentProjectId = "project-1",
	onSnapshot,
	selectedCard,
	sessionOverride,
	shellAutoRestartEnabled = true,
}: {
	currentProjectId?: string;
	onSnapshot: (snapshot: HookSnapshot) => void;
	selectedCard: CardSelection | null;
	sessionOverride?: Record<string, RuntimeTaskSessionSummary>;
	shellAutoRestartEnabled?: boolean;
}): null {
	const [sessions, setSessions] = useState<Record<string, RuntimeTaskSessionSummary>>({});
	const { upsertSession } = useTaskSessions({ currentProjectId, setSessions });
	const result = useTerminalPanels({
		currentProjectId,
		selectedCard,
		projectGit: null,
		configDefaultBaseRef: "",
		agentCommand: null,
		shellAutoRestartEnabled,
		sessions: sessionOverride ?? sessions,
		findCard: (cardId) => (selectedCard?.card.id === cardId ? selectedCard.card : null),
		upsertSession,
		sendTaskSessionInput: async () => ({ ok: true }),
	});
	useEffect(() => onSnapshot({ ...result, sessions }), [result, sessions, onSnapshot]);
	return null;
}

const HOME = "__home_terminal__";
const DETAIL_A = "__detail_terminal__:task-a";
const actEnvironment = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean };

describe("useTerminalPanels", () => {
	let container: HTMLDivElement;
	let root: Root;
	let previousActEnvironment: boolean | undefined;
	let latestSnapshot: HookSnapshot;
	const onSnapshot = (snapshot: HookSnapshot) => {
		latestSnapshot = snapshot;
	};
	const render = async (
		selectedCard: CardSelection | null = null,
		currentProjectId = "project-1",
		sessionOverride?: Record<string, RuntimeTaskSessionSummary>,
	) => {
		await act(async () => {
			root.render(
				<HookHarness
					currentProjectId={currentProjectId}
					selectedCard={selectedCard}
					sessionOverride={sessionOverride}
					onSnapshot={onSnapshot}
				/>,
			);
			await flushPromises();
		});
	};
	const action = async (callback: () => void) => {
		await act(async () => {
			callback();
			await flushPromises();
		});
	};

	beforeEach(() => {
		window.localStorage.clear();
		for (const mock of Object.values(mocks)) mock.mockReset();
		mocks.client.mockImplementation(() => ({
			runtime: {
				startShellSession: { mutate: mocks.start },
				stopTaskSession: { mutate: mocks.stop },
			},
		}));
		const runningTasks = new Set<string>();
		mocks.start.mockImplementation(async ({ taskId }: { taskId: string }) => {
			const hadExistingSession = runningTasks.has(taskId);
			runningTasks.add(taskId);
			return { ok: true, summary: createSummary(taskId), shellBinary: "/bin/zsh", hadExistingSession };
		});
		mocks.stop.mockImplementation(async ({ taskId }: { taskId: string }) => {
			runningTasks.delete(taskId);
			return {
				ok: true,
				didExit: true,
				outcome: "exited",
				summary: createSummary(taskId, { state: "awaiting_review", reviewReason: "interrupted", pid: null }),
			};
		});
		mocks.geometry.mockReturnValue({ cols: 120, rows: 24 });
		mocks.waitForGeometry.mockResolvedValue(undefined);
		mocks.controller.mockReturnValue({
			signal: new AbortController().signal,
			ready: true,
			controller: { input: () => true, paste: () => true },
		});
		mocks.waitForController.mockImplementation(async () => mocks.controller());
		previousActEnvironment = actEnvironment.IS_REACT_ACT_ENVIRONMENT;
		actEnvironment.IS_REACT_ACT_ENVIRONMENT = true;
		container = document.createElement("div");
		document.body.appendChild(container);
		root = createRoot(container);
	});
	afterEach(() => {
		act(() => root.unmount());
		container.remove();
		actEnvironment.IS_REACT_ACT_ENVIRONMENT = previousActEnvironment;
		vi.useRealTimers();
	});

	it("starts lazily and hides, collapses, navigates, resets, and disconnects without stopping shells", async () => {
		await render();
		expect(mocks.start).not.toHaveBeenCalled();
		await action(() => latestSnapshot.handleToggleHomeTerminal());
		expect(latestSnapshot.isHomeTerminalOpen).toBe(true);
		await action(() => latestSnapshot.closeHomeTerminal());
		expect(latestSnapshot.isHomeTerminalOpen).toBe(false);
		await action(() => latestSnapshot.handleToggleHomeTerminal());
		await action(() => latestSnapshot.collapseHomeTerminal());
		await render(createSelection("task-a"));
		await action(() => latestSnapshot.handleToggleDetailTerminal());
		await action(() => latestSnapshot.collapseDetailTerminal());
		await action(() => latestSnapshot.handleToggleDetailTerminal());
		await render(createSelection("task-b"));
		expect(latestSnapshot.isDetailTerminalOpen).toBe(false);
		await render(createSelection("task-a"));
		expect(latestSnapshot.isDetailTerminalOpen).toBe(false);
		await action(() => latestSnapshot.handleToggleDetailTerminal());
		await render(null, "project-2");
		await action(() => latestSnapshot.resetTerminalPanelsState());
		await action(() => latestSnapshot.handleToggleHomeTerminal());
		act(() => root.unmount());
		root = createRoot(container);
		expect(mocks.stop).not.toHaveBeenCalled();
		expect(mocks.dispose).toHaveBeenCalledWith("project-1", HOME);
		expect(mocks.dispose).toHaveBeenCalledWith("project-1", DETAIL_A);
		expect(mocks.dispose).toHaveBeenCalledWith("project-2", HOME);
	});

	it.each([false, true])(
		"explicitly terminates only the selected shell and waits for exit (detail: %s)",
		async (detail) => {
			await render(detail ? createSelection("task-a") : null);
			await action(() =>
				detail ? latestSnapshot.handleToggleDetailTerminal() : latestSnapshot.handleToggleHomeTerminal(),
			);
			await action(() =>
				detail ? latestSnapshot.terminateDetailTerminal() : latestSnapshot.terminateHomeTerminal(),
			);
			expect(mocks.stop).toHaveBeenCalledExactlyOnceWith({ taskId: detail ? DETAIL_A : HOME, waitForExit: true });
			expect(detail ? latestSnapshot.isDetailTerminalOpen : latestSnapshot.isHomeTerminalOpen).toBe(false);
		},
	);

	it.each(["timed_out", "failed", "requested"])(
		"does not replace a shell after an unsuccessful %s stop",
		async (outcome) => {
			await render();
			await action(() => latestSnapshot.handleToggleHomeTerminal());
			mocks.stop.mockResolvedValueOnce({
				ok: outcome === "requested",
				didExit: false,
				outcome,
				error: "Stop failed",
			});
			await action(() => latestSnapshot.handleRestartHomeTerminal());
			expect(mocks.start).toHaveBeenCalledTimes(1);
			expect(mocks.notify).toHaveBeenCalledWith("Stop failed");
			expect(latestSnapshot.isHomeTerminalStarting).toBe(false);
		},
	);

	it("surfaces an explicit termination failure instead of swallowing it", async () => {
		await render(createSelection("task-a"));
		await action(() => latestSnapshot.handleToggleDetailTerminal());
		mocks.stop.mockRejectedValueOnce(new Error("Cannot stop shell"));
		await action(() => latestSnapshot.terminateDetailTerminal());
		expect(mocks.notify).toHaveBeenCalledWith("Cannot stop shell");
		expect(mocks.start).toHaveBeenCalledTimes(1);
	});

	it("restarts only after successful process exit", async () => {
		const stop = deferred<{ ok: boolean; didExit: boolean; outcome: "exited"; summary: null }>();
		await render();
		await action(() => latestSnapshot.handleToggleHomeTerminal());
		mocks.stop.mockReturnValueOnce(stop.promise);
		await action(() => latestSnapshot.handleRestartHomeTerminal());
		expect(mocks.start).toHaveBeenCalledTimes(1);
		expect(latestSnapshot.isHomeTerminalStarting).toBe(true);
		await action(() => stop.resolve({ ok: true, didExit: true, outcome: "exited", summary: null }));
		expect(mocks.start).toHaveBeenCalledTimes(2);
	});

	it("orders termination after an admitted start, then a reopen after termination", async () => {
		const start = deferred<{ ok: boolean; summary: RuntimeTaskSessionSummary }>();
		mocks.start.mockReturnValueOnce(start.promise);
		await render();
		await action(() => latestSnapshot.handleToggleHomeTerminal());
		await action(() => latestSnapshot.terminateHomeTerminal());
		await action(() => latestSnapshot.handleToggleHomeTerminal());
		expect(mocks.stop).not.toHaveBeenCalled();
		expect(mocks.start).toHaveBeenCalledTimes(1);
		await action(() => start.resolve({ ok: true, summary: createSummary(HOME) }));
		expect(mocks.stop).toHaveBeenCalledOnce();
		expect(mocks.start).toHaveBeenCalledTimes(2);
		expect(latestSnapshot.isHomeTerminalOpen).toBe(true);
		expect(latestSnapshot.isHomeTerminalStarting).toBe(false);
	});

	it("converges rapid open/hide/reopen and restart/terminate intents", async () => {
		await render();
		await action(() => {
			latestSnapshot.handleToggleHomeTerminal();
			latestSnapshot.handleToggleHomeTerminal();
			latestSnapshot.handleToggleHomeTerminal();
		});
		expect(latestSnapshot.isHomeTerminalOpen).toBe(true);
		expect(mocks.start).toHaveBeenCalledOnce();
		await action(() => {
			latestSnapshot.handleRestartHomeTerminal();
			latestSnapshot.terminateHomeTerminal();
		});
		expect(latestSnapshot.isHomeTerminalOpen).toBe(false);
		expect(mocks.start).toHaveBeenCalledOnce();
		expect(mocks.stop).toHaveBeenCalledOnce();
	});

	it("does not let a hidden start failure clear a reopened viewer's loading state", async () => {
		const oldStart = deferred<{ ok: boolean; summary: null; error: string }>();
		const newStart = deferred<{ ok: boolean; summary: RuntimeTaskSessionSummary }>();
		mocks.start.mockReturnValueOnce(oldStart.promise).mockReturnValueOnce(newStart.promise);
		await render();
		await action(() => latestSnapshot.handleToggleHomeTerminal());
		await action(() => latestSnapshot.closeHomeTerminal());
		await action(() => latestSnapshot.handleToggleHomeTerminal());
		await action(() => oldStart.resolve({ ok: false, summary: null, error: "Old failure" }));
		expect(latestSnapshot.isHomeTerminalOpen).toBe(true);
		expect(latestSnapshot.isHomeTerminalStarting).toBe(true);
		expect(mocks.notify).not.toHaveBeenCalled();
		await action(() => newStart.resolve({ ok: true, summary: createSummary(HOME) }));
		expect(latestSnapshot.isHomeTerminalStarting).toBe(false);
	});

	it("keeps a new project's summary when an old explicit termination finishes late", async () => {
		const stop = deferred<{ ok: boolean; didExit: boolean; outcome: "exited"; summary: RuntimeTaskSessionSummary }>();
		await render();
		await action(() => latestSnapshot.handleToggleHomeTerminal());
		mocks.stop.mockReturnValueOnce(stop.promise);
		await action(() => latestSnapshot.terminateHomeTerminal());
		await render(null, "project-2");
		const currentSummary = createSummary(HOME, { sessionInstanceId: "project-2-instance", pid: 456 });
		mocks.start.mockResolvedValueOnce({ ok: true, summary: currentSummary });
		await action(() => latestSnapshot.handleToggleHomeTerminal());
		await action(() =>
			stop.resolve({
				ok: true,
				didExit: true,
				outcome: "exited",
				summary: createSummary(HOME, { state: "awaiting_review", reviewReason: "interrupted", pid: null }),
			}),
		);
		expect(latestSnapshot.sessions[HOME]).toBe(currentSummary);
		expect(latestSnapshot.isHomeTerminalOpen).toBe(true);
		expect(mocks.client.mock.calls.map(([projectId]) => projectId)).toEqual(["project-1", "project-1", "project-2"]);
	});

	it("does not dispatch a start after geometry resolves in an abandoned project", async () => {
		const geometry = deferred<void>();
		mocks.geometry.mockReturnValue(null);
		mocks.waitForGeometry.mockReturnValueOnce(geometry.promise);
		await render();
		await action(() => latestSnapshot.handleToggleHomeTerminal());
		await render(null, "project-2");
		await action(() => geometry.resolve());
		expect(mocks.start).not.toHaveBeenCalled();
		expect(latestSnapshot.isHomeTerminalOpen).toBe(false);
		expect(latestSnapshot.isHomeTerminalStarting).toBe(false);
	});

	it.each([false, true])(
		"ignores delayed start metadata/loading across project or task selection (task: %s)",
		async (taskSwitch) => {
			const start = deferred<{ ok: boolean; summary: RuntimeTaskSessionSummary; shellBinary: string }>();
			mocks.start.mockReturnValueOnce(start.promise);
			await render(taskSwitch ? createSelection("task-a") : null);
			await action(() =>
				taskSwitch ? latestSnapshot.handleToggleDetailTerminal() : latestSnapshot.handleToggleHomeTerminal(),
			);
			await render(taskSwitch ? createSelection("task-b") : null, taskSwitch ? "project-1" : "project-2");
			const newerStart = deferred<{ ok: boolean; summary: RuntimeTaskSessionSummary; shellBinary: string }>();
			mocks.start.mockReturnValueOnce(newerStart.promise);
			await action(() =>
				taskSwitch ? latestSnapshot.handleToggleDetailTerminal() : latestSnapshot.handleToggleHomeTerminal(),
			);
			await action(() =>
				start.resolve({
					ok: true,
					summary: createSummary(taskSwitch ? DETAIL_A : HOME),
					shellBinary: "/old/shell",
				}),
			);
			expect(taskSwitch ? latestSnapshot.isDetailTerminalStarting : latestSnapshot.isHomeTerminalStarting).toBe(
				true,
			);
			expect(latestSnapshot.homeTerminalShellBinary).toBeNull();
			await action(() =>
				newerStart.resolve({
					ok: true,
					summary: createSummary(taskSwitch ? "__detail_terminal__:task-b" : HOME, { pid: 222 }),
					shellBinary: "/new/shell",
				}),
			);
			expect(taskSwitch ? latestSnapshot.isDetailTerminalStarting : latestSnapshot.isHomeTerminalStarting).toBe(
				false,
			);
			expect(mocks.stop).not.toHaveBeenCalled();
		},
	);

	it("does not complete an old restart into a different project or a reopened viewer", async () => {
		const stop = deferred<{ ok: boolean; didExit: boolean; outcome: "exited"; summary: null }>();
		await render();
		await action(() => latestSnapshot.handleToggleHomeTerminal());
		mocks.stop.mockReturnValueOnce(stop.promise);
		await action(() => latestSnapshot.handleRestartHomeTerminal());
		await render(null, "project-2");
		await action(() => latestSnapshot.handleToggleHomeTerminal());
		await action(() => stop.resolve({ ok: true, didExit: true, outcome: "exited", summary: null }));
		expect(mocks.start).toHaveBeenCalledTimes(2);
		expect(latestSnapshot.isHomeTerminalOpen).toBe(true);
		expect(latestSnapshot.isHomeTerminalStarting).toBe(false);
	});

	it.each([false, true])(
		"reuses an already-open terminal for shortcuts without another process start (detail: %s)",
		async (detail) => {
			await render(detail ? createSelection("task-a") : null);
			await action(() =>
				detail ? latestSnapshot.handleToggleDetailTerminal() : latestSnapshot.handleToggleHomeTerminal(),
			);
			await act(async () => {
				expect(await latestSnapshot.prepareTerminalForShortcut()).toEqual({
					hadExistingSession: true,
					ok: true,
					targetTaskId: detail ? DETAIL_A : HOME,
					targetSessionInstanceId: `${detail ? DETAIL_A : HOME}:instance`,
					isCurrent: expect.any(Function),
				});
			});
			expect(mocks.start).toHaveBeenCalledOnce();
		},
	);

	it("reattaches a hidden running process and tells shortcuts to interrupt its previous command", async () => {
		await render();
		await action(() => latestSnapshot.handleToggleHomeTerminal());
		await action(() => latestSnapshot.closeHomeTerminal());
		await act(async () => {
			expect(await latestSnapshot.prepareTerminalForShortcut()).toEqual({
				hadExistingSession: true,
				ok: true,
				targetTaskId: HOME,
				targetSessionInstanceId: `${HOME}:instance`,
				isCurrent: expect.any(Function),
			});
		});
		expect(mocks.start).toHaveBeenCalledTimes(2);
		expect(mocks.waitForController).toHaveBeenCalledWith(
			HOME,
			{ projectId: "project-1", sessionInstanceId: `${HOME}:instance`, sessionStartedAt: 1 },
			expect.any(Object),
		);
		expect(mocks.stop).not.toHaveBeenCalled();
	});

	it("reports a reused runtime process even before browser session hydration", async () => {
		await render();
		expect(latestSnapshot.sessions).toEqual({});
		mocks.start.mockResolvedValueOnce({
			ok: true,
			summary: createSummary(HOME),
			shellBinary: "/bin/zsh",
			hadExistingSession: true,
		});
		await act(async () => {
			const prepared = await latestSnapshot.prepareTerminalForShortcut();
			expect(prepared).toMatchObject({
				ok: true,
				hadExistingSession: true,
				targetSessionInstanceId: `${HOME}:instance`,
			});
		});
	});

	it("uses the runtime's fresh-process result instead of a stale browser running summary", async () => {
		await render();
		await action(() => latestSnapshot.handleToggleHomeTerminal());
		await action(() => latestSnapshot.closeHomeTerminal());
		mocks.start.mockResolvedValueOnce({
			ok: true,
			summary: createSummary(HOME, { sessionInstanceId: "new-instance" }),
			shellBinary: "/bin/zsh",
			hadExistingSession: false,
		});
		await act(async () => {
			const prepared = await latestSnapshot.prepareTerminalForShortcut();
			expect(prepared).toMatchObject({
				ok: true,
				hadExistingSession: false,
				targetSessionInstanceId: "new-instance",
			});
		});
	});

	it("prepares a fresh exact session and invalidates it on same-task process replacement", async () => {
		await render();
		let preparation!: Awaited<ReturnType<UseTerminalPanelsResult["prepareTerminalForShortcut"]>>;
		await act(async () => {
			preparation = await latestSnapshot.prepareTerminalForShortcut();
		});
		expect(preparation).toMatchObject({
			ok: true,
			hadExistingSession: false,
			targetTaskId: HOME,
			targetSessionInstanceId: `${HOME}:instance`,
		});
		expect(preparation.isCurrent?.()).toBe(true);
		await render(null, "project-1", { [HOME]: createSummary(HOME, { sessionInstanceId: "replacement-instance" }) });
		expect(preparation.isCurrent?.()).toBe(false);
	});

	it("starts fresh after explicit termination rather than claiming an existing shortcut process", async () => {
		await render();
		await action(() => latestSnapshot.handleToggleHomeTerminal());
		await action(() => latestSnapshot.terminateHomeTerminal());
		await act(async () => {
			const prepared = await latestSnapshot.prepareTerminalForShortcut();
			expect(prepared).toMatchObject({ ok: true, hadExistingSession: false, targetTaskId: HOME });
		});
		expect(mocks.start).toHaveBeenCalledTimes(2);
	});

	it("rejects shortcut preparation when navigation occurs while connection readiness is pending", async () => {
		const ready = deferred<null>();
		mocks.waitForController.mockReturnValueOnce(ready.promise);
		await render(createSelection("task-a"));
		let preparation: Promise<{ ok: boolean }>;
		await action(() => {
			preparation = latestSnapshot.prepareTerminalForShortcut();
		});
		await render(createSelection("task-b"));
		await action(() => ready.resolve(null));
		expect(await preparation!).toEqual({ ok: false, message: "Terminal preparation was cancelled." });
		expect(latestSnapshot.isDetailTerminalOpen).toBe(false);
	});

	it("retains shared pane height across tasks and remounts, but collapse resets it without stopping", async () => {
		await render(createSelection("task-a"));
		await action(() => latestSnapshot.setDetailTerminalPaneHeight(320));
		expect(latestSnapshot.homeTerminalPaneHeight).toBe(320);
		await render(createSelection("task-b"));
		expect(latestSnapshot.detailTerminalPaneHeight).toBe(320);
		await action(() => latestSnapshot.setHomeTerminalPaneHeight(410));
		act(() => root.unmount());
		root = createRoot(container);
		await render(createSelection("task-a"));
		expect(latestSnapshot.detailTerminalPaneHeight).toBe(410);
		await action(() => latestSnapshot.handleToggleDetailTerminal());
		await action(() => latestSnapshot.collapseDetailTerminal());
		expect(latestSnapshot.detailTerminalPaneHeight).toBeUndefined();
		expect(window.localStorage.getItem(LocalStorageKey.BottomTerminalPaneHeight)).toBeNull();
		expect(mocks.stop).not.toHaveBeenCalled();
	});

	it("resets layout customizations without closing or terminating the pane", async () => {
		await render();
		await action(() => latestSnapshot.handleToggleHomeTerminal());
		await action(() => latestSnapshot.setHomeTerminalPaneHeight(420));
		await action(() => latestSnapshot.handleToggleExpandHomeTerminal());
		expect(latestSnapshot.homeTerminalPaneHeight).toBe(99999);
		await action(() => latestSnapshot.resetBottomTerminalLayoutCustomizations());
		expect(latestSnapshot.homeTerminalPaneHeight).toBeUndefined();
		expect(latestSnapshot.isHomeTerminalOpen).toBe(true);
		expect(mocks.stop).not.toHaveBeenCalled();
	});

	it("uses conditional ensure-start, never stop/start, for an attached unexpected exit", async () => {
		vi.useFakeTimers();
		const summary = createSummary(HOME, { pid: null, state: "idle", exitCode: 1 });
		await render();
		await action(() => latestSnapshot.handleToggleHomeTerminal());
		await render(null, "project-1", { [HOME]: summary });
		await action(() => latestSnapshot.handleShellExit(HOME, 1));
		await act(async () => {
			await vi.advanceTimersByTimeAsync(1000);
		});
		expect(mocks.stop).not.toHaveBeenCalled();
		expect(mocks.start).toHaveBeenLastCalledWith(
			expect.objectContaining({ expectedExitedSessionInstanceId: summary.sessionInstanceId }),
		);
		expect(mocks.controller).toHaveBeenCalledWith(HOME, {
			projectId: "project-1",
			sessionInstanceId: summary.sessionInstanceId,
		});
	});

	it.each(["hide", "project", "task", "terminate", "detach"])(
		"cancels or rejects automatic recovery after %s",
		async (reason) => {
			vi.useFakeTimers();
			const summary = createSummary(HOME, { pid: null, state: "idle", exitCode: 1 });
			await render();
			await action(() => latestSnapshot.handleToggleHomeTerminal());
			await render(null, "project-1", { [HOME]: summary });
			await action(() => latestSnapshot.handleShellExit(HOME, 1));
			if (reason === "hide") await action(() => latestSnapshot.closeHomeTerminal());
			if (reason === "project") await render(null, "project-2");
			if (reason === "task") await render(createSelection("task-b"));
			if (reason === "terminate") await action(() => latestSnapshot.terminateHomeTerminal());
			if (reason === "detach") mocks.controller.mockReturnValue(null);
			await act(async () => {
				await vi.advanceTimersByTimeAsync(1000);
			});
			expect(mocks.start).toHaveBeenCalledOnce();
		},
	);

	it.each([null, 143])("never recovers another viewer's intentional stop (exit code %s)", async (exitCode) => {
		vi.useFakeTimers();
		await render();
		await action(() => latestSnapshot.handleToggleHomeTerminal());
		await render(null, "project-1", {
			[HOME]: createSummary(HOME, { pid: null, state: "awaiting_review", reviewReason: "interrupted", exitCode }),
		});
		await action(() => latestSnapshot.handleShellExit(HOME, exitCode));
		await act(async () => {
			await vi.advanceTimersByTimeAsync(1000);
		});
		expect(mocks.start).toHaveBeenCalledOnce();
		expect(mocks.stop).not.toHaveBeenCalled();
	});
});
