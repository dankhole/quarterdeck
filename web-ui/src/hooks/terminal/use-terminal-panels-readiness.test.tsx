import { act, useCallback, useEffect, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RuntimeTaskSessionSummary } from "@/runtime/types";
import { getTerminalController, getTerminalControllerAttachment } from "@/terminal/terminal-controller-registry";
import type { TaskTerminalHandle, TaskTerminalSubscriber } from "@/terminal/terminal-reuse-manager";
import { usePersistentTerminalSession } from "@/terminal/use-persistent-terminal-session";
import { createTestTaskSessionSummary } from "@/test-utils/task-session-factory";
import { type UseTerminalPanelsResult, useTerminalPanels } from "./use-terminal-panels";

const mocks = vi.hoisted(() => ({
	start: vi.fn(),
	ensure: vi.fn(),
	dispose: vi.fn(),
	geometry: vi.fn(),
	waitForGeometry: vi.fn(),
}));
vi.mock("@/runtime/trpc-client", () => ({
	getRuntimeTrpcClient: () => ({
		runtime: {
			startShellSession: { mutate: mocks.start },
			stopTaskSession: { mutate: vi.fn() },
		},
	}),
}));
vi.mock("@/components/app-toaster", () => ({ notifyError: vi.fn() }));
vi.mock("@/terminal/terminal-pool", () => ({
	ensureDedicatedTerminal: mocks.ensure,
	disposeDedicatedTerminal: mocks.dispose,
	isDedicatedTerminalTaskId: () => true,
	writeToTerminalBuffer: vi.fn(),
}));
vi.mock("@/terminal/terminal-reuse-manager", () => ({
	acquireTaskTerminal: vi.fn(),
	releaseTaskTerminal: vi.fn(),
	stageTaskTerminalContainer: vi.fn(),
}));
vi.mock("@/terminal/terminal-geometry-registry", () => ({
	getTerminalGeometry: mocks.geometry,
	prepareWaitForTerminalGeometry: () => mocks.waitForGeometry,
}));

const HOME = "__home_terminal__";
const actEnvironment = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean };
function deferred<T>() {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((settle) => {
		resolve = settle;
	});
	return { promise, resolve };
}
const summary = (overrides: Partial<RuntimeTaskSessionSummary> = {}) =>
	createTestTaskSessionSummary({
		taskId: HOME,
		sessionInstanceId: "shell-instance",
		agentId: null,
		pid: 123,
		startedAt: 10,
		state: "running",
		...overrides,
	});
async function flush() {
	for (let index = 0; index < 12; index++) await Promise.resolve();
}

class FakeTerminal implements TaskTerminalHandle {
	private readonly subscribers = new Set<TaskTerminalSubscriber>();
	private ready = false;
	private transportSummary = summary();
	subscribe = (subscriber: TaskTerminalSubscriber) => {
		this.subscribers.add(subscriber);
		subscriber.onSummary?.(this.transportSummary);
		if (this.ready) subscriber.onConnectionReady?.(HOME);
		subscriber.onInputSessionChange?.(this.ready ? this.transportSummary : null);
		return () => {
			this.subscribers.delete(subscriber);
		};
	};
	markReady() {
		this.ready = true;
		for (const subscriber of this.subscribers) {
			subscriber.onConnectionReady?.(HOME);
			subscriber.onInputSessionChange?.(this.transportSummary);
		}
	}
	reconnect(value: RuntimeTaskSessionSummary) {
		this.ready = false;
		this.transportSummary = value;
		for (const subscriber of this.subscribers) {
			subscriber.onInputSessionChange?.(null);
			subscriber.onSummary?.(value);
		}
	}
	emitExit() {
		for (const subscriber of this.subscribers) subscriber.onExit?.(HOME, 1);
	}
	attachToStageContainer = vi.fn();
	show = vi.fn();
	hide = vi.fn();
	park = vi.fn();
	reset = vi.fn();
	requestRestore = vi.fn();
	input = vi.fn(() => true);
	paste = vi.fn(() => true);
	waitForLikelyPrompt = vi.fn(async () => true);
	clear = vi.fn();
	stop = vi.fn(async () => {});
	focus = vi.fn();
}

interface Snapshot extends UseTerminalPanelsResult {
	setSummary: (value: RuntimeTaskSessionSummary) => void;
}
function Viewer({ value, panels }: { value?: RuntimeTaskSessionSummary; panels: UseTerminalPanelsResult }) {
	const { containerRef } = usePersistentTerminalSession({
		taskId: HOME,
		projectId: "project-1",
		sessionInstanceId: value?.sessionInstanceId,
		sessionStartedAt: value?.startedAt,
		onExit: panels.handleShellExit,
		terminalBackgroundColor: "black",
		cursorColor: "white",
	});
	return <div ref={containerRef} />;
}
function Harness({ showViewer, onSnapshot }: { showViewer: boolean; onSnapshot: (value: Snapshot) => void }) {
	const [sessions, setSessions] = useState<Record<string, RuntimeTaskSessionSummary>>({});
	const setSummary = useCallback(
		(value: RuntimeTaskSessionSummary) => setSessions((current) => ({ ...current, [HOME]: value })),
		[],
	);
	const upsertSession = useCallback(
		(_projectId: string, value: RuntimeTaskSessionSummary) => setSummary(value),
		[setSummary],
	);
	const panels = useTerminalPanels({
		currentProjectId: "project-1",
		selectedCard: null,
		projectGit: null,
		configDefaultBaseRef: "main",
		agentCommand: null,
		shellAutoRestartEnabled: true,
		sessions,
		findCard: () => null,
		upsertSession,
		sendTaskSessionInput: async () => ({ ok: true }),
	});
	useEffect(() => onSnapshot({ ...panels, setSummary }), [panels, setSummary, onSnapshot]);
	return showViewer && panels.isHomeTerminalOpen ? <Viewer panels={panels} value={sessions[HOME]} /> : null;
}

describe("manual shell exact-viewer readiness and lifetime", () => {
	let root: Root;
	let container: HTMLDivElement;
	let snapshot: Snapshot;
	let terminals: FakeTerminal[];
	let previousActEnvironment: boolean | undefined;
	const onSnapshot = (value: Snapshot) => {
		snapshot = value;
	};
	const render = async (showViewer = true) =>
		act(async () => {
			root.render(<Harness showViewer={showViewer} onSnapshot={onSnapshot} />);
			await flush();
		});
	const action = async (callback: () => void) =>
		act(async () => {
			callback();
			await flush();
		});
	const latestTerminal = () => {
		const terminal = terminals.at(-1);
		if (!terminal) throw new Error("Expected mounted viewer");
		return terminal;
	};
	beforeEach(() => {
		for (const mock of Object.values(mocks)) mock.mockReset();
		mocks.start.mockResolvedValue({
			ok: true,
			summary: summary(),
			shellBinary: "/bin/zsh",
			hadExistingSession: false,
		});
		mocks.geometry.mockReturnValue({ cols: 120, rows: 24 });
		mocks.waitForGeometry.mockResolvedValue(undefined);
		terminals = [];
		mocks.ensure.mockImplementation(() => {
			const terminal = new FakeTerminal();
			terminals.push(terminal);
			return terminal;
		});
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

	it("replays exact transport readiness after the start response without replacing the viewer", async () => {
		const start = deferred<{ ok: boolean; summary: RuntimeTaskSessionSummary; hadExistingSession: boolean }>();
		mocks.start.mockReturnValueOnce(start.promise);
		await render();
		let preparation!: ReturnType<UseTerminalPanelsResult["prepareTerminalForShortcut"]>;
		let settled = false;
		await action(() => {
			preparation = snapshot.prepareTerminalForShortcut();
			void preparation.then(() => {
				settled = true;
			});
		});
		const viewer = latestTerminal();
		await action(() => viewer.markReady());
		expect(getTerminalController(HOME)).toBeNull();
		expect(settled).toBe(false);
		await action(() => start.resolve({ ok: true, summary: summary(), hadExistingSession: false }));
		expect(terminals).toEqual([viewer]);
		expect(getTerminalControllerAttachment(HOME)?.ready).toBe(true);
		expect(settled).toBe(true);
		const prepared = await preparation;
		expect(prepared).toMatchObject({ ok: true, targetSessionInstanceId: "shell-instance" });
		expect(prepared.isCurrent?.()).toBe(true);
		expect(getTerminalController(HOME)?.input("run command")).toBe(true);
	});

	it("waits for the corrected start timestamp and a ready transport on the same viewer", async () => {
		await render();
		await action(() => snapshot.handleToggleHomeTerminal());
		const viewer = latestTerminal();
		await action(() => viewer.markReady());
		const oldAttachment = getTerminalControllerAttachment(HOME);
		expect(oldAttachment?.ready).toBe(true);
		await action(() => snapshot.setSummary(summary({ pid: null, state: "idle" })));
		const correctedSummary = summary({ startedAt: 20 });
		mocks.start.mockResolvedValueOnce({ ok: true, summary: correctedSummary, hadExistingSession: true });
		let preparation!: ReturnType<UseTerminalPanelsResult["prepareTerminalForShortcut"]>;
		let settled = false;
		await action(() => {
			preparation = snapshot.prepareTerminalForShortcut();
			void preparation.then(() => {
				settled = true;
			});
		});
		const replacement = getTerminalControllerAttachment(HOME, {
			projectId: "project-1",
			sessionInstanceId: "shell-instance",
			sessionStartedAt: 20,
		});
		expect(oldAttachment?.signal.aborted).toBe(true);
		expect(terminals).toEqual([viewer]);
		expect(replacement?.ready).toBe(false);
		expect(settled).toBe(false);
		await action(() => viewer.reconnect(correctedSummary));
		expect(replacement?.ready).toBe(false);
		expect(settled).toBe(false);
		await action(() => viewer.markReady());
		expect(await preparation).toMatchObject({ ok: true, hadExistingSession: true });
	});

	it("waits through viewer replacement for the new transport, not a disposed ready signal", async () => {
		await render();
		let preparation!: ReturnType<UseTerminalPanelsResult["prepareTerminalForShortcut"]>;
		let settled = false;
		await action(() => {
			preparation = snapshot.prepareTerminalForShortcut();
			void preparation.then(() => {
				settled = true;
			});
		});
		const old = latestTerminal();
		await render(false);
		await render(true);
		expect(latestTerminal()).not.toBe(old);
		await action(() => old.markReady());
		expect(settled).toBe(false);
		await action(() => latestTerminal().markReady());
		expect(await preparation).toMatchObject({ ok: true });
	});

	it("cancels exact readiness waiting immediately when the panel is hidden", async () => {
		await render();
		let preparation!: ReturnType<UseTerminalPanelsResult["prepareTerminalForShortcut"]>;
		await action(() => {
			preparation = snapshot.prepareTerminalForShortcut();
		});
		await action(() => snapshot.closeHomeTerminal());
		expect(await preparation).toMatchObject({ ok: false, message: "Terminal preparation was cancelled." });
	});

	it("preserves conditional recovery when the original attachment survives async geometry preparation", async () => {
		vi.useFakeTimers();
		await render();
		await action(() => snapshot.handleToggleHomeTerminal());
		await action(() => latestTerminal().markReady());
		await action(() => snapshot.setSummary(summary({ pid: null, state: "idle", exitCode: 1 })));
		const geometry = deferred<void>();
		mocks.geometry.mockReturnValue(null);
		mocks.waitForGeometry.mockReturnValueOnce(geometry.promise);
		await action(() => latestTerminal().emitExit());
		await act(async () => {
			await vi.advanceTimersByTimeAsync(1000);
		});
		expect(mocks.start).toHaveBeenCalledOnce();
		await action(() => geometry.resolve());
		expect(mocks.start).toHaveBeenCalledTimes(2);
		expect(mocks.start).toHaveBeenLastCalledWith(
			expect.objectContaining({ expectedExitedSessionInstanceId: "shell-instance" }),
		);
	});

	it.each([false, true])(
		"abandons the exit viewer's recovery after detach/reattach (geometry already pending: %s)",
		async (duringGeometry) => {
			vi.useFakeTimers();
			await render();
			await action(() => snapshot.handleToggleHomeTerminal());
			await action(() => latestTerminal().markReady());
			await action(() => snapshot.setSummary(summary({ pid: null, state: "idle", exitCode: 1 })));
			const geometry = deferred<void>();
			if (duringGeometry) {
				mocks.geometry.mockReturnValue(null);
				mocks.waitForGeometry.mockReturnValueOnce(geometry.promise);
			}
			await action(() => latestTerminal().emitExit());
			if (duringGeometry)
				await act(async () => {
					await vi.advanceTimersByTimeAsync(1000);
				});
			await render(false);
			await render(true);
			await action(() => latestTerminal().markReady());
			await action(() => geometry.resolve());
			await act(async () => {
				await vi.advanceTimersByTimeAsync(1000);
			});
			expect(mocks.start).toHaveBeenCalledOnce();
			expect(snapshot.isHomeTerminalStarting).toBe(false);
		},
	);
});
