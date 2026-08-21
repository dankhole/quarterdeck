import { afterEach, describe, expect, it, vi } from "vitest";

import { CODEX_HOOK_TIMEOUT_SECONDS } from "../../../src/codex-hooks";
import {
	HOOK_INGEST_ATTEMPT_TIMEOUT_MS,
	HOOK_INGEST_RETRY_DELAY_MS,
	withAbortableTimeout,
} from "../../../src/commands/hooks";

describe("withAbortableTimeout", () => {
	it("keeps both reliable ingest attempts inside Codex's hook deadline", () => {
		const retryBudget = HOOK_INGEST_ATTEMPT_TIMEOUT_MS * 2 + HOOK_INGEST_RETRY_DELAY_MS;
		expect(retryBudget).toBeLessThan(CODEX_HOOK_TIMEOUT_SECONDS * 1_000 - 1_000);
	});

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
