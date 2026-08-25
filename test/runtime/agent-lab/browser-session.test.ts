import { describe, expect, it, vi } from "vitest";

import { _testing } from "../../../scripts/agent-lab/browser-session";

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
