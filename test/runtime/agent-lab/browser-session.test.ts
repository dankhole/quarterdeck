import * as childProcess from "node:child_process";
import { ChildProcess } from "node:child_process";
import { describe, expect, it, vi } from "vitest";
import * as browserProcesses from "../../../scripts/agent-lab/browser-processes";
import { _testing, closeAgentLabBrowserSession } from "../../../scripts/agent-lab/browser-session";
import * as core from "../../../src/core";

vi.mock("node:child_process", async (importOriginal) => ({
	...(await importOriginal<typeof childProcess>()),
	spawn: vi.fn(),
}));

describe("Agent Lab browser session cleanup", () => {
	it("reaps finalized/abandoned sessions without launching another CLI", async () => {
		const group = {
			pid: 80906,
			pgid: 80906,
			startTime: "Thu Oct 22 16:31:06 2026",
			commandLine: "node cliDaemon.js qd-abandoned-run",
		};
		const tree = {
			rootPids: [80906],
			processPids: [80906, 80907],
			identities: [
				group,
				{ pid: 80907, pgid: 80906, startTime: "Thu Oct 22 16:31:07 2026", commandLine: "chrome-headless-shell" },
			],
			groups: [group],
		};
		const inspect = vi
			.spyOn(browserProcesses, "findAgentLabBrowserProcessTree")
			.mockResolvedValueOnce(tree)
			.mockResolvedValueOnce(tree)
			.mockResolvedValue({ rootPids: [], processPids: [] });
		const terminate = vi.spyOn(browserProcesses, "terminateAgentLabBrowserProcessTree").mockResolvedValue([]);
		const spawn = vi.mocked(childProcess.spawn).mockImplementation(() => {
			throw new Error("Recovery must not start a CLI");
		});
		try {
			await expect(
				closeAgentLabBrowserSession("/repo", "qd-abandoned-run", { mode: "owned-processes-only" }),
			).resolves.toBeUndefined();
			expect(inspect).toHaveBeenNthCalledWith(1, "/repo", "qd-abandoned-run", { groups: [] });
			expect(inspect).toHaveBeenNthCalledWith(2, "/repo", "qd-abandoned-run", { groups: [group] });
			expect(terminate).toHaveBeenCalledWith(tree);
			expect(spawn).not.toHaveBeenCalled();
		} finally {
			vi.restoreAllMocks();
		}
	});

	it("retains a reparented child's identity across cleanup retry passes", async () => {
		const identity = { pid: 11, startTime: "Thu Oct 22 16:31:07 2026", commandLine: "chrome-headless-shell" };
		const group = {
			pid: 10,
			pgid: 10,
			startTime: "Thu Oct 22 16:31:06 2026",
			commandLine: "node cliDaemon.js qd-abandoned-run",
		};
		const tree = { rootPids: [10], processPids: [10, 11], identities: [identity], groups: [group] };
		const terminate = vi.fn().mockResolvedValueOnce([11]).mockResolvedValue([]);
		const inspect = vi.fn(async () => ({ rootPids: [], processPids: [] }));
		await expect(
			_testing.terminateUntilBrowserSessionIsQuiescent(tree, { inspect, terminate, wait: async () => {} }),
		).resolves.toEqual([]);
		expect(terminate).toHaveBeenNthCalledWith(2, {
			rootPids: [],
			processPids: [11],
			identities: [identity],
			groups: [group],
		});
	});

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
