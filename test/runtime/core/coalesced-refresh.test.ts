import { describe, expect, it, vi } from "vitest";

import { CoalescedRefresh } from "../../../src/core/coalesced-refresh";

function deferred<T>() {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((done) => {
		resolve = done;
	});
	return { promise, resolve };
}

describe("CoalescedRefresh", () => {
	it("shares one follow-up run among callers that arrive mid-run", async () => {
		const refresh = new CoalescedRefresh<number>();
		const gates = [deferred<number>(), deferred<number>()];
		let calls = 0;
		const task = vi.fn(() => gates[calls++]?.promise ?? Promise.resolve(-1));
		const first = refresh.run(task);
		const second = refresh.run(task);
		const third = refresh.run(task);
		await Promise.resolve();
		expect(task).toHaveBeenCalledTimes(1);
		gates[0]?.resolve(1);
		await expect(first).resolves.toBe(1);
		await vi.waitFor(() => expect(task).toHaveBeenCalledTimes(2));
		gates[1]?.resolve(2);
		// Mid-run callers observe the run that started after their request.
		await expect(Promise.all([second, third])).resolves.toEqual([2, 2]);
		await expect(refresh.run(async () => 3)).resolves.toBe(3);
	});

	it("starts the follow-up even when the running build fails", async () => {
		const refresh = new CoalescedRefresh<string>();
		const gate = deferred<void>();
		const failing = refresh.run(async () => {
			await gate.promise;
			throw new Error("synthetic");
		});
		const next = refresh.run(async () => "recovered");
		gate.resolve();
		await expect(failing).rejects.toThrow("synthetic");
		await expect(next).resolves.toBe("recovered");
	});
});
