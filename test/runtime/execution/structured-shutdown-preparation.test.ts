import { describe, expect, it, vi } from "vitest";

import { createStructuredShutdownPreparation } from "../../../src/execution";

describe("createStructuredShutdownPreparation", () => {
	it("quiesces reconciliation but preserves owners for crash-simulation cleanup skips", async () => {
		const stopReconciliation = vi.fn();
		const waitForReconciliation = vi.fn(async () => undefined);
		const stopOwners = vi.fn(async () => undefined);
		const prepare = createStructuredShutdownPreparation({
			stopReconciliation,
			waitForReconciliation,
			stopOwners,
		});

		await prepare({ skipSessionCleanup: true });
		await prepare();

		expect(stopReconciliation).toHaveBeenCalledTimes(1);
		expect(waitForReconciliation).toHaveBeenCalledTimes(1);
		expect(stopOwners).not.toHaveBeenCalled();
	});

	it("stops owners exactly once during normal shutdown", async () => {
		const stopOwners = vi.fn(async () => undefined);
		const prepare = createStructuredShutdownPreparation({
			stopReconciliation: vi.fn(),
			waitForReconciliation: vi.fn(async () => undefined),
			stopOwners,
		});

		await Promise.all([prepare(), prepare()]);
		expect(stopOwners).toHaveBeenCalledTimes(1);
	});
});
