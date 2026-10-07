import { describe, expect, it, vi } from "vitest";
import { waitForDesktopHelperExit } from "../../../scripts/agent-lab/desktop-helper-exit";
import type { DesktopLabProcess } from "../../../scripts/agent-lab/desktop-types";

const helper: DesktopLabProcess = {
	pid: 50001,
	parentPid: 50000,
	startedAt: "original birth",
	command: "owned helper",
};

describe("desktop helper exit before port reservation", () => {
	it("waits past a live exact helper before admitting a freed-port reservation", async () => {
		const listProcesses = vi
			.fn()
			.mockResolvedValueOnce([helper])
			.mockResolvedValueOnce([helper])
			.mockResolvedValue([]);
		await waitForDesktopHelperExit(helper, { listProcesses, pollIntervalMs: 1, timeoutMs: 100 });
		expect(listProcesses).toHaveBeenCalledTimes(3);
	});

	it("does not wait for an unrelated process that reused the numeric PID", async () => {
		await expect(
			waitForDesktopHelperExit(helper, {
				listProcesses: async () => [{ ...helper, startedAt: "new birth", command: "unrelated process" }],
			}),
		).resolves.toBeUndefined();
	});

	it("fails boundedly when the exact original helper remains alive", async () => {
		await expect(
			waitForDesktopHelperExit(helper, { listProcesses: async () => [helper], pollIntervalMs: 1, timeoutMs: 5 }),
		).rejects.toThrow("exact original helper exited");
	});

	it("fails closed on an unavailable process census", async () => {
		await expect(
			waitForDesktopHelperExit(helper, {
				listProcesses: async () => {
					throw new Error("process census unavailable");
				},
			}),
		).rejects.toThrow("process census unavailable");
	});
});
