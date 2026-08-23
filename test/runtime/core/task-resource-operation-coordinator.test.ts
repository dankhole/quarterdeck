import { describe, expect, it } from "vitest";

import { TaskResourceOperationCoordinator } from "../../../src/core";

function createDeferred<T>(): {
	promise: Promise<T>;
	resolve: (value: T | PromiseLike<T>) => void;
} {
	let resolve!: (value: T | PromiseLike<T>) => void;
	const promise = new Promise<T>((nextResolve) => {
		resolve = nextResolve;
	});
	return { promise, resolve };
}

describe("TaskResourceOperationCoordinator", () => {
	it("serializes the same project task across independent callers", async () => {
		const coordinator = new TaskResourceOperationCoordinator();
		const gate = createDeferred<void>();
		const callOrder: string[] = [];
		const first = coordinator.run("project-1", "task-1", async () => {
			callOrder.push("delete:start");
			await gate.promise;
			callOrder.push("delete:end");
		});
		const second = coordinator.run("project-1", "task-1", async () => {
			callOrder.push("start");
		});

		await Promise.resolve();
		expect(callOrder).toEqual(["delete:start"]);
		gate.resolve();
		await Promise.all([first, second]);
		expect(callOrder).toEqual(["delete:start", "delete:end", "start"]);
	});

	it("does not serialize the same task id across different projects", async () => {
		const coordinator = new TaskResourceOperationCoordinator();
		const gate = createDeferred<void>();
		const callOrder: string[] = [];
		const first = coordinator.run("project-1", "task-1", async () => {
			callOrder.push("project-1:start");
			await gate.promise;
		});
		const second = coordinator.run("project-2", "task-1", async () => {
			callOrder.push("project-2");
		});

		await second;
		expect(callOrder).toEqual(["project-1:start", "project-2"]);
		gate.resolve();
		await first;
	});

	it("allows the next operation to repair an earlier failure", async () => {
		const coordinator = new TaskResourceOperationCoordinator();
		const failure = new Error("stop failed");
		const first = coordinator.run("project-1", "task-failure", async () => {
			throw failure;
		});
		const second = coordinator.run("project-1", "task-failure", async () => "recovered");

		await expect(first).rejects.toBe(failure);
		await expect(second).resolves.toBe("recovered");
	});
});
