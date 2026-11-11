import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createTestTaskSessionSummary } from "@/test-utils/task-session-factory";
import { type UseShellAutoRestartResult, useShellAutoRestart } from "./use-shell-auto-restart";

const HOME = "__home_terminal__";
const DETAIL = "__detail_terminal__:task-a";
const actEnvironment = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean };
type Options = Parameters<typeof useShellAutoRestart>[0];

function exitedSummary(taskId = HOME) {
	return createTestTaskSessionSummary({
		taskId,
		agentId: null,
		pid: null,
		state: "idle",
		reviewReason: null,
		exitCode: 1,
		sessionInstanceId: "exited-instance",
		startedAt: 12,
	});
}

describe("useShellAutoRestart", () => {
	let container: HTMLDivElement;
	let root: Root;
	let result: UseShellAutoRestartResult;
	let options: Options;
	let previousActEnvironment: boolean | undefined;
	let lifetime: AbortController;
	let attachment: NonNullable<ReturnType<Options["getTerminalAttachment"]>>;
	function Harness({ value }: { value: Options }) {
		result = useShellAutoRestart(value);
		return null;
	}
	const render = () => act(() => root.render(<Harness value={options} />));
	const advance = async () => {
		await act(async () => {
			await vi.advanceTimersByTimeAsync(1000);
		});
	};

	beforeEach(() => {
		vi.useFakeTimers();
		previousActEnvironment = actEnvironment.IS_REACT_ACT_ENVIRONMENT;
		actEnvironment.IS_REACT_ACT_ENVIRONMENT = true;
		container = document.createElement("div");
		document.body.appendChild(container);
		root = createRoot(container);
		lifetime = new AbortController();
		attachment = { controller: { input: () => true, paste: () => true }, signal: lifetime.signal, ready: true };
		options = {
			projectId: "project-1",
			scopeKey: "project-1/home/1",
			shellAutoRestartEnabled: true,
			restartHomeTerminal: vi.fn(async () => true),
			restartDetailTerminal: vi.fn(async () => true),
			writeToTerminal: vi.fn(),
			getTerminalAttachment: vi.fn(() => attachment),
			getSessionSummary: vi.fn((taskId) => exitedSummary(taskId)),
		};
		render();
	});
	afterEach(() => {
		act(() => root.unmount());
		container.remove();
		actEnvironment.IS_REACT_ACT_ENVIRONMENT = previousActEnvironment;
		vi.useRealTimers();
	});

	it.each([HOME, DETAIL])("passes exact exited identity to a single conditional restart for %s", async (taskId) => {
		act(() => {
			result.handleShellExit(taskId, 1);
			result.handleShellExit(taskId, 1);
		});
		expect(options.writeToTerminal).not.toHaveBeenCalled();
		await advance();
		if (taskId === HOME)
			expect(options.restartHomeTerminal).toHaveBeenCalledExactlyOnceWith("exited-instance", attachment);
		else
			expect(options.restartDetailTerminal).toHaveBeenCalledExactlyOnceWith("task-a", "exited-instance", attachment);
	});

	it.each([0, null])("does not restart successful or ambiguous/signal exits: %s", async (exitCode) => {
		act(() => result.handleShellExit(HOME, exitCode));
		await advance();
		expect(options.restartHomeTerminal).not.toHaveBeenCalled();
	});

	it("rechecks enabled state when a timer fires", async () => {
		act(() => result.handleShellExit(HOME, 1));
		options = { ...options, shellAutoRestartEnabled: false };
		render();
		await advance();
		expect(options.restartHomeTerminal).not.toHaveBeenCalled();
	});

	it("requires an actually attached exact-instance viewer, not only an open panel flag", async () => {
		act(() => result.handleShellExit(HOME, 1));
		options = { ...options, getTerminalAttachment: vi.fn(() => null) };
		render();
		await advance();
		expect(options.restartHomeTerminal).not.toHaveBeenCalled();
	});

	it.each([
		{ state: "awaiting_review" as const, reviewReason: "interrupted" as const, exitCode: 143 },
		{ state: "awaiting_review" as const, reviewReason: "interrupted" as const, exitCode: null },
		{ sessionInstanceId: "replacement-instance" },
		{ pid: 234, state: "running" as const },
		{ exitCode: 2 },
	])("rechecks authoritative identity/exit meaning after scheduling: %j", async (overrides) => {
		act(() => result.handleShellExit(HOME, 1));
		options = { ...options, getSessionSummary: () => ({ ...exitedSummary(), ...overrides }) };
		render();
		await advance();
		expect(options.restartHomeTerminal).not.toHaveBeenCalled();
	});

	it("cancels timers and ignores old exit callbacks across project and viewer scopes", async () => {
		const oldExit = result.handleShellExit;
		act(() => oldExit(HOME, 1));
		options = { ...options, projectId: "project-2", scopeKey: "project-2/home/1" };
		render();
		act(() => oldExit(HOME, 1));
		await advance();
		expect(options.restartHomeTerminal).not.toHaveBeenCalled();
		act(() => result.handleShellExit(HOME, 1));
		await advance();
		expect(options.restartHomeTerminal).toHaveBeenCalledOnce();
	});

	it("cancels pending timers explicitly", async () => {
		act(() => {
			result.handleShellExit(HOME, 1);
			result.cancelPendingRestart(HOME);
		});
		await advance();
		expect(options.restartHomeTerminal).not.toHaveBeenCalled();
	});

	it("abandons recovery when Files/Git unmounts the viewer even if Terminal remounts before the timer", async () => {
		act(() => result.handleShellExit(HOME, 1));
		lifetime.abort();
		attachment = { ...attachment, signal: new AbortController().signal };
		await advance();
		expect(options.restartHomeTerminal).not.toHaveBeenCalled();
	});

	it("requires the original attachment object even when a caller forgets to abort the old lifetime", async () => {
		act(() => result.handleShellExit(HOME, 1));
		attachment = { ...attachment, signal: new AbortController().signal };
		await advance();
		expect(options.restartHomeTerminal).not.toHaveBeenCalled();
	});

	it("retains rate limiting across viewer-generation changes", async () => {
		for (let attempt = 0; attempt < 4; attempt += 1) {
			options = { ...options, scopeKey: `project-1/home/${attempt}` };
			render();
			act(() => result.handleShellExit(HOME, 1));
			await advance();
		}
		expect(options.restartHomeTerminal).toHaveBeenCalledTimes(3);
		expect(options.writeToTerminal).toHaveBeenLastCalledWith(HOME, expect.stringContaining("click restart"));
	});

	it("does not start another recovery while the current conditional start is pending", async () => {
		let finish!: (value: boolean) => void;
		options = {
			...options,
			restartHomeTerminal: vi.fn(
				() =>
					new Promise<boolean>((resolve) => {
						finish = resolve;
					}),
			),
		};
		render();
		act(() => result.handleShellExit(HOME, 1));
		await advance();
		act(() => result.handleShellExit(HOME, 1));
		await advance();
		expect(options.restartHomeTerminal).toHaveBeenCalledOnce();
		await act(async () => finish(true));
	});

	it("cancels pending timers on unmount", async () => {
		act(() => result.handleShellExit(HOME, 1));
		act(() => root.unmount());
		root = createRoot(container);
		await advance();
		expect(options.restartHomeTerminal).not.toHaveBeenCalled();
	});
});
