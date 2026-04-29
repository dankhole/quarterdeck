import { afterEach, describe, expect, it, vi } from "vitest";

import {
	createProjectOrphanMaintenanceTimer,
	PROJECT_ORPHAN_MAINTENANCE_TAXONOMY,
	runProjectOrphanMaintenanceSweep,
} from "../../../src/server/project-orphan-maintenance";

describe("project orphan maintenance taxonomy", () => {
	it("documents each cleanup class and its owner", () => {
		expect(PROJECT_ORPHAN_MAINTENANCE_TAXONOMY.map((entry) => entry.className)).toEqual([
			"session_drift",
			"process_artifacts",
			"filesystem_locks",
			"orphan_worktrees",
			"dangling_state_references",
		]);
		expect(PROJECT_ORPHAN_MAINTENANCE_TAXONOMY.find((entry) => entry.className === "session_drift")?.schedule).toBe(
			"session reconciliation timer",
		);
		expect(
			PROJECT_ORPHAN_MAINTENANCE_TAXONOMY.find((entry) => entry.className === "filesystem_locks")?.schedule,
		).toBe("startup plus project orphan-maintenance timer");
	});
});

describe("runProjectOrphanMaintenanceSweep", () => {
	it("deduplicates project paths before cleaning stale git locks", async () => {
		const cleanStaleGitIndexLocks = vi.fn().mockResolvedValue(undefined);
		const warn = vi.fn();

		await runProjectOrphanMaintenanceSweep({
			getProjectRepoPaths: () => ["/repo/a", null, "/repo/a", undefined, "/repo/b"],
			cleanStaleGitIndexLocks,
			warn,
		});

		expect(cleanStaleGitIndexLocks).toHaveBeenCalledWith(["/repo/a", "/repo/b"], warn);
	});

	it("skips the filesystem cleanup when no project paths are known", async () => {
		const cleanStaleGitIndexLocks = vi.fn().mockResolvedValue(undefined);

		await runProjectOrphanMaintenanceSweep({
			getProjectRepoPaths: () => [],
			cleanStaleGitIndexLocks,
		});

		expect(cleanStaleGitIndexLocks).not.toHaveBeenCalled();
	});
});

describe("createProjectOrphanMaintenanceTimer", () => {
	afterEach(() => {
		vi.useRealTimers();
	});

	it("runs project artifact cleanup on its own interval and stops cleanly", async () => {
		vi.useFakeTimers();
		const cleanStaleGitIndexLocks = vi.fn().mockResolvedValue(undefined);
		const timer = createProjectOrphanMaintenanceTimer(
			{
				getProjectRepoPaths: () => ["/repo/a"],
				cleanStaleGitIndexLocks,
			},
			100,
		);

		timer.start();
		await vi.advanceTimersByTimeAsync(100);
		expect(cleanStaleGitIndexLocks).toHaveBeenCalledTimes(1);

		timer.stop();
		await vi.advanceTimersByTimeAsync(100);
		expect(cleanStaleGitIndexLocks).toHaveBeenCalledTimes(1);
	});

	it("does not overlap sweeps when cleanup is still running", async () => {
		vi.useFakeTimers();
		let resolveCleanup: () => void = () => {};
		const cleanStaleGitIndexLocks = vi.fn(
			() =>
				new Promise<void>((resolve) => {
					resolveCleanup = resolve;
				}),
		);
		const timer = createProjectOrphanMaintenanceTimer(
			{
				getProjectRepoPaths: () => ["/repo/a"],
				cleanStaleGitIndexLocks,
			},
			100,
		);

		timer.start();
		await vi.advanceTimersByTimeAsync(100);
		await vi.advanceTimersByTimeAsync(100);
		expect(cleanStaleGitIndexLocks).toHaveBeenCalledTimes(1);

		resolveCleanup();
		await Promise.resolve();
		await vi.advanceTimersByTimeAsync(100);
		expect(cleanStaleGitIndexLocks).toHaveBeenCalledTimes(2);

		timer.stop();
	});
});
