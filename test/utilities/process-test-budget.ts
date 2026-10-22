import { afterAll, vi } from "vitest";

/**
 * Real git/process-backed fixtures spawn many child processes per test (some
 * files spawn several hundred). Under heavy machine load each spawn can take
 * far longer than usual even though the test itself is correct, which can
 * exceed the fast-lane default `testTimeout`/`hookTimeout` (15s/10s from
 * `vitest.config.ts`). Call this once at module scope (not inside a hook) in
 * a process-heavy test file to raise both timeouts for that file only: a
 * per-test timeout is bound during collection, before any `beforeAll` runs,
 * so `vi.setConfig` only takes effect for tests collected after it runs
 * synchronously at the top of the file. `afterAll` resets the override so it
 * cannot leak into other files sharing the same worker.
 */
export function useProcessTestBudget(timeoutMs = 60_000): void {
	vi.setConfig({ testTimeout: timeoutMs, hookTimeout: timeoutMs });
	afterAll(() => {
		vi.resetConfig();
	});
}
