import { afterEach, describe, expect, it, vi } from "vitest";

import { withAbortableTimeout } from "../../../src/commands/hooks";

describe("withAbortableTimeout", () => {
	afterEach(() => {
		vi.useRealTimers();
	});

	it("aborts pending work when the timeout elapses", async () => {
		vi.useFakeTimers();
		const receivedSignals: AbortSignal[] = [];

		const promise = withAbortableTimeout(
			async (signal) => {
				receivedSignals.push(signal);
				await new Promise<never>(() => {});
			},
			25,
			"quarterdeck hooks ingest",
		);
		const expectation = expect(promise).rejects.toThrow("quarterdeck hooks ingest timed out after 25ms");

		await vi.advanceTimersByTimeAsync(25);

		await expectation;
		expect(receivedSignals[0]?.aborted).toBe(true);
	});
});
