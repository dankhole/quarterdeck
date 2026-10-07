import { ChildProcess } from "node:child_process";
import { describe, expect, it, vi } from "vitest";
import { _testing } from "../../../scripts/agent-lab/browser-session";
import * as core from "../../../src/core";

describe("Agent Lab browser session cleanup", () => {
	it("terminates a daemon that appears after the first empty verification snapshot", async () => {
		const replacementTree = { rootPids: [20], processPids: [20, 21] };
		const snapshots = [
			{ rootPids: [], processPids: [] },
			replacementTree,
			{ rootPids: [], processPids: [] },
			{ rootPids: [], processPids: [] },
		];
		const inspect = vi.fn(async () => snapshots.shift() ?? { rootPids: [], processPids: [] });
		const terminate = vi.fn(async () => []);

		await expect(
			_testing.terminateUntilBrowserSessionIsQuiescent(
				{ rootPids: [10], processPids: [10, 11] },
				{ inspect, terminate, wait: async () => {} },
			),
		).resolves.toEqual([]);

		expect(terminate).toHaveBeenNthCalledWith(1, { rootPids: [10], processPids: [10, 11] });
		expect(terminate).toHaveBeenNthCalledWith(2, replacementTree);
		expect(inspect).toHaveBeenCalledTimes(4);
	});
});

const namedSnapshot = (pids: number[], rootPids: number[] = []) => ({
	tree: { rootPids, processPids: rootPids.length ? pids : [] },
	processes: pids.map((pid) => ({ pid, parentPid: pid === 10 ? 1 : 10 })),
});
const closed = { exitCode: 0, signal: null, error: null };

describe("named-session-only browser cleanup", () => {
	it("confirms closure only after two empty scans", async () => {
		const inspect = vi
			.fn()
			.mockResolvedValueOnce(namedSnapshot([10, 11], [10]))
			.mockResolvedValue(namedSnapshot([]));
		const wait = vi.fn(async () => {});
		await expect(
			_testing.closeNamedSessionOnly({ inspect, close: async () => closed, wait }),
		).resolves.toBeUndefined();
		expect(inspect).toHaveBeenCalledTimes(3);
		expect(wait).toHaveBeenCalledTimes(1);
	});

	it("cannot lose an initial descendant when its daemon exits and it reparents", async () => {
		const inspect = vi
			.fn()
			.mockResolvedValueOnce(namedSnapshot([10, 11], [10]))
			.mockResolvedValue({
				tree: { rootPids: [], processPids: [] },
				processes: [{ pid: 11, parentPid: 1 }],
			});
		await expect(
			_testing.closeNamedSessionOnly({ inspect, close: async () => closed, wait: async () => {} }),
		).rejects.toThrow("unconfirmed");
	});

	it("retains newly observed children after their parent exits", async () => {
		const inspect = vi
			.fn()
			.mockResolvedValueOnce(namedSnapshot([10, 11], [10]))
			.mockResolvedValueOnce({
				tree: { rootPids: [], processPids: [] },
				processes: [
					{ pid: 11, parentPid: 1 },
					{ pid: 12, parentPid: 11 },
				],
			})
			.mockResolvedValue({ tree: { rootPids: [], processPids: [] }, processes: [{ pid: 12, parentPid: 1 }] });
		await expect(
			_testing.closeNamedSessionOnly({ inspect, close: async () => closed, wait: async () => {} }),
		).rejects.toThrow("unconfirmed");
	});

	it.each(["initial-inspection", "missing-root", "close-error", "close-exit", "verification-inspection"])(
		"fails closed for %s without a termination fallback",
		async (failure) => {
			const inspect = vi
				.fn()
				.mockResolvedValueOnce(namedSnapshot([10, 11], [10]))
				.mockResolvedValue(namedSnapshot([]));
			if (failure === "initial-inspection")
				inspect.mockReset().mockRejectedValue(new Error("private inspection data"));
			if (failure === "missing-root") inspect.mockReset().mockResolvedValue(namedSnapshot([]));
			if (failure === "verification-inspection")
				inspect
					.mockReset()
					.mockResolvedValueOnce(namedSnapshot([10, 11], [10]))
					.mockRejectedValue(new Error("inspection unavailable"));
			const close = vi.fn(async () => ({
				...closed,
				error: failure === "close-error" ? new Error("private command data") : null,
				exitCode: failure === "close-exit" ? 1 : 0,
			}));
			const terminate = vi.spyOn(core, "terminateProcessTree");
			try {
				await expect(_testing.closeNamedSessionOnly({ inspect, close, wait: async () => {} })).rejects.toThrow();
				expect(close).toHaveBeenCalledTimes(1);
				expect(terminate).not.toHaveBeenCalled();
			} finally {
				terminate.mockRestore();
			}
		},
	);

	it("does not signal even the wrapper child on timeout", async () => {
		vi.useFakeTimers();
		const child = new ChildProcess();
		const unref = vi.spyOn(child, "unref");
		const kill = vi.spyOn(child, "kill");
		const terminate = vi.spyOn(core, "terminateProcessTree");
		try {
			const result = _testing.runBrowserCloseCommand(() => child, true, 20);
			await vi.advanceTimersByTimeAsync(20);
			expect((await result).error?.message).toBe("Browser close command timed out.");
			expect(unref).toHaveBeenCalledTimes(1);
			expect(kill).not.toHaveBeenCalled();
			expect(terminate).not.toHaveBeenCalled();
		} finally {
			terminate.mockRestore();
			vi.useRealTimers();
		}
	});

	it.each(["", "malformed process row", "1 0 node\n1 0 duplicate", "0 0 node"])(
		"rejects unreadable process evidence instead of treating it as empty",
		(text) => {
			expect(() => _testing.parseStrictBrowserProcesses(text)).toThrow("unconfirmed");
		},
	);
});
