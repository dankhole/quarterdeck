import { afterEach, describe, expect, it, vi } from "vitest";

import type { RuntimeProjectStateResponse } from "../../../src/core";
import type { ProjectStatePublicationPreparation } from "../../../src/server/project-registry";
import { ProjectStatePublicationScheduler } from "../../../src/server/project-state-publication-scheduler";

function state(revision: number): RuntimeProjectStateResponse {
	return {
		repoPath: "/repo",
		statePath: "/state",
		git: { currentBranch: null, defaultBranch: null, branches: [] },
		board: { columns: [] },
		sessions: {},
		revision,
	} as RuntimeProjectStateResponse;
}

function deferred<T>() {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((done) => {
		resolve = done;
	});
	return { promise, resolve };
}

afterEach(() => {
	vi.useRealTimers();
});

describe("ProjectStatePublicationScheduler", () => {
	it("returns immediately and coalesces a burst into the highest committed revision", async () => {
		const gate = deferred<void>();
		const prepare = vi.fn(async (_projectId: string, input: RuntimeProjectStateResponse) => {
			await gate.promise;
			return { status: "ready", state: input } satisfies ProjectStatePublicationPreparation;
		});
		const publish = vi.fn();
		const scheduler = new ProjectStatePublicationScheduler({ prepare, publish });
		scheduler.schedule("p", state(1));
		scheduler.schedule("p", state(3));
		scheduler.schedule("p", state(2));
		scheduler.schedule("p", state(4));
		expect(publish).not.toHaveBeenCalled();
		gate.resolve();
		await vi.waitFor(() => expect(publish).toHaveBeenCalledTimes(2));
		await scheduler.waitForIdle();
		expect(prepare.mock.calls.map(([, input]) => input.revision)).toEqual([1, 4]);
		expect(publish.mock.calls.map(([, published]) => published.revision)).toEqual([1, 4]);
	});

	it("never publishes a lower revision than one already published", async () => {
		const publish = vi.fn();
		const scheduler = new ProjectStatePublicationScheduler({
			prepare: async (_projectId, input) => ({ status: "ready", state: input }),
			publish,
		});
		scheduler.schedule("p", state(5));
		await vi.waitFor(() => expect(publish).toHaveBeenCalledTimes(1));
		scheduler.schedule("p", state(4));
		scheduler.schedule("p", state(5));
		await scheduler.waitForIdle();
		expect(publish.mock.calls.map(([, published]) => published.revision)).toEqual([5, 5]);
	});

	it("retries metadata churn with bounded backoff using the newest committed state", async () => {
		vi.useFakeTimers();
		const outcomes: Array<ProjectStatePublicationPreparation["status"]> = ["metadata_changed", "metadata_changed"];
		const prepare = vi.fn(async (_projectId: string, input: RuntimeProjectStateResponse) => {
			const status = outcomes.shift() ?? "ready";
			return status === "ready"
				? ({ status, state: input } as const)
				: ({ status } as ProjectStatePublicationPreparation);
		});
		const publish = vi.fn();
		const scheduler = new ProjectStatePublicationScheduler({ prepare, publish, retryDelaysMs: [10, 20] });
		scheduler.schedule("p", state(1));
		await vi.advanceTimersByTimeAsync(0);
		expect(prepare).toHaveBeenCalledTimes(1);
		await vi.advanceTimersByTimeAsync(10);
		expect(prepare).toHaveBeenCalledTimes(2);
		// A newer commit during backoff replaces the retried state and runs now.
		scheduler.schedule("p", state(2));
		await vi.advanceTimersByTimeAsync(0);
		expect(prepare).toHaveBeenCalledTimes(3);
		expect(publish).toHaveBeenCalledTimes(1);
		expect(publish.mock.calls[0]?.[1].revision).toBe(2);
	});

	it("drops after the retry budget and on supersession", async () => {
		vi.useFakeTimers();
		const dropped = vi.fn();
		const prepare = vi.fn(async (): Promise<ProjectStatePublicationPreparation> => ({ status: "metadata_changed" }));
		const publish = vi.fn();
		const scheduler = new ProjectStatePublicationScheduler({
			prepare,
			publish,
			retryDelaysMs: [10],
			onPublicationDropped: dropped,
		});
		scheduler.schedule("p", state(1));
		await vi.advanceTimersByTimeAsync(100);
		expect(prepare).toHaveBeenCalledTimes(2);
		expect(dropped).toHaveBeenCalledWith("p", "retries_exhausted");

		prepare.mockResolvedValueOnce({ status: "superseded" });
		scheduler.schedule("p", state(2));
		await vi.advanceTimersByTimeAsync(100);
		expect(dropped).toHaveBeenLastCalledWith("p", "superseded");
		expect(publish).not.toHaveBeenCalled();
	});

	it("drainProject waits for the in-flight run and fences later schedules until release", async () => {
		const gate = deferred<void>();
		const prepare = vi.fn(async (_projectId: string, input: RuntimeProjectStateResponse) => {
			await gate.promise;
			return { status: "ready", state: input } satisfies ProjectStatePublicationPreparation;
		});
		const publish = vi.fn();
		const scheduler = new ProjectStatePublicationScheduler({ prepare, publish });
		scheduler.schedule("p", state(1));
		scheduler.schedule("p", state(2));
		let drained = false;
		const drain = scheduler.drainProject("p").then(() => {
			drained = true;
		});
		scheduler.schedule("p", state(3));
		await Promise.resolve();
		expect(drained).toBe(false);
		gate.resolve();
		await drain;
		// The in-flight result is not published once the lane is drained.
		expect(publish).not.toHaveBeenCalled();
		expect(prepare).toHaveBeenCalledTimes(1);

		scheduler.releaseProject("p");
		scheduler.schedule("p", state(4));
		await vi.waitFor(() => expect(publish).toHaveBeenCalledTimes(1));
		expect(publish.mock.calls[0]?.[1].revision).toBe(4);
	});

	it("close cancels pending work, awaits in-flight runs, and ignores later schedules", async () => {
		const gate = deferred<void>();
		const prepare = vi.fn(async (_projectId: string, input: RuntimeProjectStateResponse) => {
			await gate.promise;
			return { status: "ready", state: input } satisfies ProjectStatePublicationPreparation;
		});
		const publish = vi.fn();
		const scheduler = new ProjectStatePublicationScheduler({ prepare, publish });
		scheduler.schedule("a", state(1));
		scheduler.schedule("a", state(2));
		const closed = scheduler.close();
		scheduler.schedule("b", state(1));
		gate.resolve();
		await closed;
		await scheduler.waitForIdle();
		expect(prepare).toHaveBeenCalledTimes(1);
		expect(publish).not.toHaveBeenCalled();
	});

	it("isolates projects so one slow enrichment does not delay another", async () => {
		const gate = deferred<void>();
		const publish = vi.fn();
		const scheduler = new ProjectStatePublicationScheduler({
			prepare: async (projectId, input) => {
				if (projectId === "slow") await gate.promise;
				return { status: "ready", state: input };
			},
			publish,
		});
		scheduler.schedule("slow", state(1));
		scheduler.schedule("fast", state(1));
		await vi.waitFor(() => expect(publish).toHaveBeenCalledWith("fast", expect.anything()));
		expect(publish).not.toHaveBeenCalledWith("slow", expect.anything());
		gate.resolve();
		await scheduler.waitForIdle();
		expect(publish).toHaveBeenCalledWith("slow", expect.anything());
	});

	it("contains a throwing broadcast so drains and later publications still work", async () => {
		const publish = vi.fn((_projectId: string, _state: RuntimeProjectStateResponse): void => {
			throw new Error("synthetic broadcast failure");
		});
		const scheduler = new ProjectStatePublicationScheduler({
			prepare: async (_projectId, input) => ({ status: "ready", state: input }),
			publish,
		});
		scheduler.schedule("p", state(1));
		await vi.waitFor(() => expect(publish).toHaveBeenCalledOnce());
		await expect(scheduler.drainProject("p")).resolves.toBeUndefined();
		scheduler.releaseProject("p");
		publish.mockImplementation(() => undefined);
		scheduler.schedule("p", state(2));
		await vi.waitFor(() => expect(publish).toHaveBeenLastCalledWith("p", expect.objectContaining({ revision: 2 })));
		await expect(scheduler.close()).resolves.toBeUndefined();
	});
});
