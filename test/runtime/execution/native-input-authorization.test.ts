import { describe, expect, it, vi } from "vitest";
import type { TaskExecutionOwnership } from "../../../src/execution/execution-ownership-contracts";
import { NativeInputAuthorizationSubscriptions } from "../../../src/state/native-input-authorization";

function owner(taskId = "task"): TaskExecutionOwnership {
	return {
		projectId: "project",
		taskId,
		provider: "codex",
		providerSessionId: "session",
		providerSessionTreeId: null,
		providerProfileFingerprint: "a".repeat(64),
		configurationFingerprint: null,
		providerVersion: "test",
		protocolSchemaFingerprint: "b".repeat(64),
		historyMode: null,
		state: "native_tui",
		ownerGeneration: 0,
		ownerSessionInstanceId: "instance",
		ownerProcess: null,
		activeTurn: null,
		pendingHandoff: null,
		lastFailure: null,
		updatedAt: 0,
	};
}

describe("NativeInputAuthorizationSubscriptions", () => {
	it("verifies once, preserves unrelated writes and revokes changed authority synchronously", async () => {
		const subscriptions = new NativeInputAuthorizationSubscriptions();
		const value = owner();
		const verify = vi.fn(async () => {
			subscriptions.publish("project", { task: value }, "token");
		});
		const reader = subscriptions.create("project", "task", verify, async () => "token");
		const observed = await reader.read();
		await reader.read();
		expect(verify).toHaveBeenCalledTimes(1);
		subscriptions.invalidateChanged("project", { task: value, other: owner("other") });
		expect(reader.isCurrent(observed)).toBe(true);
		subscriptions.invalidateChanged("project", { task: { ...value, ownerGeneration: 1 } });
		expect(reader.isCurrent(observed)).toBe(false);
		await reader.read();
		expect(verify).toHaveBeenCalledTimes(2);
		reader.dispose();
		expect(reader.isCurrent(observed)).toBe(false);
		await expect(reader.read()).rejects.toThrow("disposed");
	});
	it("does not reinstall a verified snapshot invalidated while verification completes", async () => {
		const subscriptions = new NativeInputAuthorizationSubscriptions();
		let attempts = 0;
		const replacement = { ...owner(), ownerGeneration: 1 };
		const reader = subscriptions.create(
			"project",
			"task",
			async () => {
				attempts++;
				if (attempts === 1) {
					subscriptions.publish("project", { task: owner() }, "token");
					subscriptions.invalidate("project");
				} else subscriptions.publish("project", { task: replacement }, "token");
			},
			async () => "token",
		);
		expect((await reader.read())?.ownerGeneration).toBe(1);
		expect(attempts).toBe(2);
		reader.dispose();
	});
	it("keeps failed verification unknown and retries durably", async () => {
		const subscriptions = new NativeInputAuthorizationSubscriptions();
		let fail = true;
		const reader = subscriptions.create(
			"project",
			"task",
			async () => {
				if (fail) throw new Error("disk failure");
				subscriptions.publish("project", {}, "token");
			},
			async () => "token",
		);
		await expect(reader.read()).rejects.toThrow("disk failure");
		expect(reader.isCurrent(null)).toBe(false);
		fail = false;
		expect(await reader.read()).toBeNull();
		expect(reader.isCurrent(null)).toBe(true);
		reader.dispose();
	});
	it("reverifies external replacement and ignores a stale stat completing after local publication", async () => {
		const subscriptions = new NativeInputAuthorizationSubscriptions();
		let token = "old";
		let current = owner();
		const verify = vi.fn(async () => subscriptions.publish("project", { task: current }, token));
		const readToken = vi.fn(async () => token);
		const reader = subscriptions.create("project", "task", verify, readToken);
		await reader.read();
		token = "external";
		current = { ...current, ownerGeneration: 1 };
		expect((await reader.read())?.ownerGeneration).toBe(1);
		expect(verify).toHaveBeenCalledTimes(2);
		readToken.mockImplementationOnce(async () => {
			token = "local";
			current = { ...current, ownerGeneration: 2 };
			subscriptions.publish("project", { task: current }, token);
			return "external";
		});
		expect((await reader.read())?.ownerGeneration).toBe(2);
		expect(verify).toHaveBeenCalledTimes(2);
		reader.dispose();
	});
	it("fails closed after stat failure without discarding a newer publication", async () => {
		const subscriptions = new NativeInputAuthorizationSubscriptions();
		const verify = vi.fn(async () => subscriptions.publish("project", {}, "token"));
		const readToken = vi.fn(async () => "token");
		const reader = subscriptions.create("project", "task", verify, readToken);
		await reader.read();
		readToken.mockRejectedValueOnce(new Error("stat failed"));
		await expect(reader.read()).rejects.toThrow("stat failed");
		expect(reader.isCurrent(null)).toBe(false);
		await reader.read();
		expect(verify).toHaveBeenCalledTimes(2);
		readToken.mockImplementationOnce(async () => {
			subscriptions.publish("project", {}, "token");
			throw new Error("obsolete stat failed");
		});
		expect(await reader.read()).toBeNull();
		expect(verify).toHaveBeenCalledTimes(2);
		reader.dispose();
	});
});
