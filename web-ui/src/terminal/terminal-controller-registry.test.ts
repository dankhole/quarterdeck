// @vitest-environment node
import { describe, expect, it, vi } from "vitest";

import {
	getTerminalController,
	getTerminalControllerAttachment,
	registerTerminalController,
	waitForTerminalController,
} from "@/terminal/terminal-controller-registry";

describe("terminal controller identity", () => {
	const scope = { projectId: "a", sessionInstanceId: "one" };
	const controller = () => ({ input: vi.fn(() => true), paste: vi.fn(() => true) });

	it("waits for exact registration and transport readiness in either arrival order", async () => {
		const taskId = "readiness-task";
		const cancellation = new AbortController();
		const resolved = vi.fn();
		const wait = waitForTerminalController(taskId, scope, { signal: cancellation.signal, isCurrent: () => true });
		void wait.then(resolved);
		let markReady!: (ready: boolean) => void;
		const unregister = registerTerminalController(taskId, controller(), scope, (notify) => {
			markReady = notify;
			return () => {};
		});
		try {
			await Promise.resolve();
			expect(resolved).not.toHaveBeenCalled();
			markReady(true);
			const attachment = await wait;
			expect(attachment).toBe(getTerminalControllerAttachment(taskId, scope));
			expect(
				await waitForTerminalController(taskId, scope, { signal: cancellation.signal, isCurrent: () => true }),
			).toBe(attachment);
		} finally {
			unregister();
			cancellation.abort();
		}
	});

	it("ignores readiness from replaced viewers and waits for the replacement's own transport", async () => {
		const taskId = "replacement-task";
		const cancellation = new AbortController();
		let oldReady!: (ready: boolean) => void;
		let newReady!: (ready: boolean) => void;
		const oldUnregister = registerTerminalController(taskId, controller(), scope, (notify) => {
			oldReady = notify;
			return () => {};
		});
		const oldAttachment = getTerminalControllerAttachment(taskId, scope);
		const wait = waitForTerminalController(taskId, scope, { signal: cancellation.signal, isCurrent: () => true });
		const newUnregister = registerTerminalController(taskId, controller(), scope, (notify) => {
			newReady = notify;
			return () => {};
		});
		try {
			expect(oldAttachment?.signal.aborted).toBe(true);
			oldReady(true);
			expect(getTerminalControllerAttachment(taskId, scope)?.ready).toBe(false);
			newReady(true);
			expect(await wait).toBe(getTerminalControllerAttachment(taskId, scope));
			oldUnregister();
			expect(getTerminalControllerAttachment(taskId, scope)?.signal.aborted).toBe(false);
		} finally {
			oldUnregister();
			newUnregister();
			cancellation.abort();
		}
	});

	it("does not accept an already-ready pre-commit viewer with an outdated sessionStartedAt", async () => {
		const taskId = "timestamp-task";
		const cancellation = new AbortController();
		const oldUnregister = registerTerminalController(taskId, controller(), { ...scope, sessionStartedAt: 10 });
		const resolved = vi.fn();
		const wait = waitForTerminalController(
			taskId,
			{ ...scope, sessionStartedAt: 20 },
			{ signal: cancellation.signal, isCurrent: () => true },
		);
		void wait.then(resolved);
		await Promise.resolve();
		expect(resolved).not.toHaveBeenCalled();
		const newUnregister = registerTerminalController(taskId, controller(), { ...scope, sessionStartedAt: 20 });
		try {
			expect(await wait).toBe(getTerminalControllerAttachment(taskId, { ...scope, sessionStartedAt: 20 }));
		} finally {
			oldUnregister();
			newUnregister();
			cancellation.abort();
		}
	});

	it("cancels a wait immediately when panel intent is abandoned", async () => {
		const cancellation = new AbortController();
		const wait = waitForTerminalController("cancelled-task", scope, {
			signal: cancellation.signal,
			isCurrent: () => true,
		});
		cancellation.abort();
		expect(await wait).toBeNull();
	});

	it("fails closed when scope validity changes before a registration arrives", async () => {
		const cancellation = new AbortController();
		let current = true;
		const wait = waitForTerminalController("stale-task", scope, {
			signal: cancellation.signal,
			isCurrent: () => current,
		});
		current = false;
		const unregister = registerTerminalController("stale-task", controller(), scope);
		try {
			expect(await wait).toBeNull();
		} finally {
			unregister();
			cancellation.abort();
		}
	});
	it("does not resolve a duplicate home task ID across project or session scope", () => {
		const taskId = "__home_terminal__";
		const first = { input: vi.fn(() => true), paste: vi.fn(() => true) };
		const second = { input: vi.fn(() => true), paste: vi.fn(() => true) };
		const disposeFirst = registerTerminalController(taskId, first, { projectId: "a", sessionInstanceId: "one" });
		const disposeSecond = registerTerminalController(taskId, second, { projectId: "b", sessionInstanceId: "two" });
		try {
			expect(getTerminalController(taskId, { projectId: "a" })).toBeNull();
			expect(getTerminalController(taskId, { projectId: "b", sessionInstanceId: "one" })).toBeNull();
			expect(getTerminalController(taskId, { projectId: "b", sessionInstanceId: "two" })).toBe(second);
			disposeFirst();
			expect(getTerminalController(taskId, { projectId: "b" })).toBe(second);
		} finally {
			disposeFirst();
			disposeSecond();
		}
		expect(getTerminalController(taskId)).toBeNull();
	});
});
