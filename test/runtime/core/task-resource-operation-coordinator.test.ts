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
	it("retains admitted project and unscoped work until all effects settle", async () => {
		const coordinator = new TaskResourceOperationCoordinator();
		const scoped = createDeferred<void>();
		const unscoped = createDeferred<void>();
		const first = coordinator.run("project", "task", async () => await scoped.promise);
		const second = coordinator.runProject(null, async () => await unscoped.promise);
		let idle = false;
		const draining = coordinator.waitForIdle().then(() => {
			idle = true;
		});
		scoped.resolve();
		await first;
		expect(idle).toBe(false);
		unscoped.resolve();
		await Promise.all([second, draining]);
		expect(idle).toBe(true);
	});

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

		await new Promise<void>((resolve) => setImmediate(resolve));
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

	it("drains every task before relocation and fences later project operations", async () => {
		const coordinator = new TaskResourceOperationCoordinator();
		const taskDone = createDeferred<void>();
		const moveDone = createDeferred<void>();
		const order: string[] = [];
		const task = coordinator.run("project", "task", async () => {
			order.push("task");
			await taskDone.promise;
		});
		const move = coordinator.runProjectExclusive("project", async () => {
			order.push("move");
			// Stop helpers re-enter ordinary admission while the exclusive operation owns it.
			await coordinator.run("project", "task", async () => order.push("stop"));
			await moveDone.promise;
		});
		const late = coordinator.runProject("project", async () => order.push("late"));
		await coordinator.runProject("other-project", async () => order.push("other"));
		expect(order).toEqual(["other", "task"]);
		taskDone.resolve();
		await new Promise<void>((resolve) => setImmediate(resolve));
		expect(order).toEqual(["other", "task", "move", "stop"]);
		moveDone.resolve();
		await Promise.all([task, move, late]);
		expect(order).toEqual(["other", "task", "move", "stop", "late"]);
	});

	it("keeps subsequent exclusive operations ordered after a failed relocation", async () => {
		const coordinator = new TaskResourceOperationCoordinator();
		const first = coordinator.runProjectExclusive("project", async () => {
			throw new Error("move failed");
		});
		const next = coordinator.runProjectExclusive("project", async () => "recovered");
		await expect(first).rejects.toThrow("move failed");
		await expect(next).resolves.toBe("recovered");
	});

	it("revokes inherited admission when an operation finishes before its deferred callback", async () => {
		const coordinator = new TaskResourceOperationCoordinator();
		const callbackReady = createDeferred<void>();
		const moveDone = createDeferred<void>();
		let callback: Promise<void> | undefined;
		let ran = false;
		await coordinator.runProject("project", async () => {
			callback = callbackReady.promise.then(() =>
				coordinator.runProject("project", async () => {
					ran = true;
				}),
			);
		});
		const move = coordinator.runProjectExclusive("project", async () => await moveDone.promise);
		callbackReady.resolve();
		await new Promise<void>((resolve) => setImmediate(resolve));
		expect(ran).toBe(false);
		moveDone.resolve();
		await Promise.all([move, callback]);
		expect(ran).toBe(true);
	});
});
