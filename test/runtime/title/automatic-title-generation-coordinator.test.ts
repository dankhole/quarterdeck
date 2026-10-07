import { describe, expect, it, vi } from "vitest";

import { AutomaticTitleGenerationCoordinator } from "../../../src/title/automatic-title-generation-coordinator";

describe("automatic title generation shutdown", () => {
	it("drains admitted generation and rejects subsequent batches after listener disposal", async () => {
		const coordinator = new AutomaticTitleGenerationCoordinator();
		let finish!: () => void;
		const gate = new Promise<void>((resolve) => {
			finish = resolve;
		});
		const generation = coordinator.runIfIdle("project", "task", async () => await gate);
		let closed = false;
		const closing = coordinator.close().then(() => {
			closed = true;
		});
		const late = vi.fn(async () => undefined);
		expect(coordinator.runIfIdle("project", "late-task", late)).toBeNull();
		await Promise.resolve();
		expect(closed).toBe(false);
		finish();
		await Promise.all([generation, closing]);
		expect(closed).toBe(true);
		expect(late).not.toHaveBeenCalled();
	});
});
