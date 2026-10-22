import { afterEach, describe, expect, it, vi } from "vitest";

import { CODEX_HOOK_TIMEOUT_SECONDS } from "../../../src/codex-hooks";
import {
	HOOK_INGEST_ATTEMPT_TIMEOUT_MS,
	HOOK_INGEST_RETRY_DELAY_MS,
	HOOK_INGEST_TOTAL_TIMEOUT_MS,
	withAbortableTimeout,
} from "../../../src/commands/hooks";
import { HOOK_TRANSITION_LIVE_REPLAY_MIN_AGE_MS } from "../../../src/hook-transition-outbox";

describe("withAbortableTimeout", () => {
	it("keeps both reliable ingest attempts inside Codex's hook deadline", () => {
		expect(HOOK_INGEST_TOTAL_TIMEOUT_MS).toBeLessThan(CODEX_HOOK_TIMEOUT_SECONDS * 1_000 - 1_000);
	});

	it("leaves a retry window after a timed-out first attempt", () => {
		const retryWindow = HOOK_INGEST_TOTAL_TIMEOUT_MS - HOOK_INGEST_ATTEMPT_TIMEOUT_MS - HOOK_INGEST_RETRY_DELAY_MS;
		expect(retryWindow).toBeGreaterThanOrEqual(500);
	});

	it("finishes or abandons delivery before periodic outbox replay may adopt the record", () => {
		expect(HOOK_INGEST_TOTAL_TIMEOUT_MS + 1_000).toBeLessThanOrEqual(HOOK_TRANSITION_LIVE_REPLAY_MIN_AGE_MS);
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
