import { describe, expect, it } from "vitest";

import { KeyedOperationCoordinator } from "../../../src/core";

function createGate(): { promise: Promise<void>; release: () => void } {
	let release!: () => void;
	const promise = new Promise<void>((resolve) => {
		release = resolve;
	});
	return { promise, release };
}

describe("KeyedOperationCoordinator", () => {
	it("serializes operations sharing a key", async () => {
		const coordinator = new KeyedOperationCoordinator();
		const gate = createGate();
		const order: string[] = [];
		const first = coordinator.run("task-1", async () => {
			order.push("first:start");
			await gate.promise;
			order.push("first:end");
		});
		const second = coordinator.run("task-1", async () => {
			order.push("second");
		});

		await Promise.resolve();
		expect(order).toEqual(["first:start"]);
		gate.release();
		await Promise.all([first, second]);
		expect(order).toEqual(["first:start", "first:end", "second"]);
	});

	it("allows unrelated keys to proceed concurrently", async () => {
		const coordinator = new KeyedOperationCoordinator();
		const gate = createGate();
		const first = coordinator.run("task-1", async () => await gate.promise);
		const second = coordinator.run("task-2", async () => "completed");

		await expect(second).resolves.toBe("completed");
		gate.release();
		await first;
	});

	it("continues after a rejected operation", async () => {
		const coordinator = new KeyedOperationCoordinator();
		const first = coordinator.run("task-1", async () => {
			throw new Error("failed");
		});
		const second = coordinator.run("task-1", async () => "recovered");

		await expect(first).rejects.toThrow("failed");
		await expect(second).resolves.toBe("recovered");
	});
});
