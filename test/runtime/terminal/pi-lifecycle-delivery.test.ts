import { afterEach, describe, expect, it, vi } from "vitest";

import type { RuntimeHookIngestRequest } from "../../../src/core/api/task-session";
import { compareSameProducerHookDeliveries } from "../../../src/hook-delivery-order";
import { HookPublicationUnavailableError } from "../../../src/hook-reliable-delivery";
import { createPiLifecycleClockHarness } from "../../utilities/pi-lifecycle-clock-harness";

function deferred() {
	let resolve = () => {};
	const promise = new Promise<undefined>((settle) => {
		resolve = () => settle(undefined);
	});
	return { promise, resolve };
}

async function tick() {
	for (let index = 0; index < 12; index += 1) await Promise.resolve();
}

afterEach(() => vi.restoreAllMocks());

describe("Pi reliable publication and shutdown", () => {
	it("awaits publication, not network, and freezes identity/time before any queue", async () => {
		const publication = deferred();
		const network = deferred();
		vi.spyOn(Date, "now").mockReturnValue(1_000);
		const h = createPiLifecycleClockHarness({
			publish: () => publication.promise,
			deliver: () => network.promise,
		});
		let returned = false;
		const callback = Promise.resolve(h.fire("agent_start")).then(() => {
			returned = true;
		});
		expect(h.publications).toHaveLength(0);
		vi.mocked(Date.now).mockReturnValue(9_000);
		h.context.sessionManager.getSessionId = () => "replacement";
		await tick();
		const captured = h.publications[0];
		expect(captured).toMatchObject({
			delivery: { id: expect.any(String), occurredAt: 1_000 },
			metadata: { turnId: "turn-1", sessionId: "pi-session-1" },
		});
		expect(returned).toBe(false);
		expect(h.deliveries).toEqual([]);
		publication.resolve();
		await callback;
		expect(returned).toBe(true);
		await tick();
		expect(h.deliveries).toEqual([captured]);
		expect(captured?.delivery?.occurredAt).toBe(1_000);
		expect(captured?.metadata?.sessionId).toBe("pi-session-1");
		expect(h.spawn).not.toHaveBeenCalled();
		network.resolve();
		await h.dispose();
	});

	it("waits for the head's local rename before publishing B, without waiting for A's network", async () => {
		const first = deferred();
		const second = deferred();
		const network = deferred();
		let index = 0;
		const h = createPiLifecycleClockHarness({
			publish: () => (++index === 1 ? first.promise : second.promise),
			deliver: () => network.promise,
		});
		const start = h.fire("agent_start");
		const end = h.fire("agent_end");
		await tick();
		expect(h.publications).toHaveLength(1);
		expect(h.deliveries).toEqual([]);
		first.resolve();
		await start;
		await tick();
		expect(h.publications).toHaveLength(2);
		expect(h.deliveries).toEqual([h.publications[0]]);
		second.resolve();
		await end;
		expect(h.deliveries).toHaveLength(1);
		network.resolve();
		await h.drain();
		expect(h.deliveries).toEqual(h.publications);
		await h.dispose();
	});

	it("retries a failed head before publishing the next callback, using its unchanged ID and time", async () => {
		let attempts = 0;
		const h = createPiLifecycleClockHarness({
			publish: async () => {
				if (++attempts === 1) throw new Error("synthetic rename failure");
			},
		});
		await expect(h.fire("agent_start")).rejects.toThrow("hook is unprotected");
		await h.fire("agent_end");
		await h.drain();
		expect(h.publications).toHaveLength(3);
		expect(h.publications[1]).toBe(h.publications[0]);
		expect(h.publications[2]?.metadata?.hookEventName).toBe("AgentEnd");
		expect(h.deliveries).toEqual(h.publications.slice(1));
		await h.dispose();
	});

	it("does not publish B across a persistently failed A and retains both for bounded shutdown retry", async () => {
		const h = createPiLifecycleClockHarness({
			publish: async () => {
				throw new Error("disk unavailable");
			},
		});
		await expect(h.fire("agent_start")).rejects.toThrow("hook is unprotected");
		await expect(h.fire("agent_end")).rejects.toThrow("hook is unprotected");
		expect(h.publications).toHaveLength(2);
		expect(h.publications[1]).toBe(h.publications[0]);
		await expect(h.fire("session_shutdown")).rejects.toThrow("unprotected");
		expect(h.publications).toHaveLength(3);
		expect(h.publications.every((request) => request === h.publications[0])).toBe(true);
		expect(h.calls).toEqual([]);
		await h.dispose().catch(() => {});
	});

	it("hands successors to replay after a deferred head instead of allowing network overtaking", async () => {
		const h = createPiLifecycleClockHarness({ deliver: async () => "deferred" });
		await h.fire("agent_start");
		await h.fire("agent_end");
		await h.fire("agent_settled");
		await h.drain();
		expect(h.publications).toHaveLength(3);
		expect(h.deliveries).toEqual([h.publications[0]]);
		expect(h.abandoned).toEqual(h.publications.slice(1));
		// Recovery does not silently reset this conservative instance fence.
		await h.fire("agent_start");
		await h.drain();
		expect(h.deliveries).toHaveLength(1);
		expect(h.abandoned).toHaveLength(3);
		await h.dispose();
	});

	it("uses ordered same-producer UUIDs without altering same-millisecond occurrence times", async () => {
		vi.spyOn(Date, "now").mockReturnValue(123_456);
		const h = createPiLifecycleClockHarness();
		await h.fire("agent_start");
		await h.fire("agent_settled");
		await h.fire("agent_start");
		await h.drain();
		const ids = h.publications.map((request) => request.delivery?.id ?? "");
		expect(ids).toEqual([...ids].sort());
		expect(new Set(ids).size).toBe(3);
		expect(compareSameProducerHookDeliveries(ids[0], ids[1])).toBeLessThan(0);
		expect(compareSameProducerHookDeliveries(ids[1], ids[2])).toBeLessThan(0);
		expect(h.publications.map((request) => request.delivery?.occurredAt)).toEqual([123_456, 123_456, 123_456]);
		await h.dispose();
	});

	it("bounds failed intent retention and explicitly rejects unprotected overflow", async () => {
		const head = deferred();
		const h = createPiLifecycleClockHarness({ publish: () => head.promise });
		const callbacks = Array.from({ length: 128 }, () => h.fire("agent_end"));
		await expect(h.fire("agent_start")).rejects.toThrow("capacity exceeded; hook is unprotected");
		head.resolve();
		await Promise.all(callbacks);
		await expect(h.fire("session_shutdown")).rejects.toThrow("unprotected");
		expect(h.publications).toHaveLength(128);
		await h.dispose().catch(() => {});
	});

	it("aborts one active delivery and abandons a long published queue without per-event waits", async () => {
		let activeSignal: AbortSignal | undefined;
		const h = createPiLifecycleClockHarness({
			deliver: (_request, signal) =>
				new Promise<undefined>((resolve) => {
					activeSignal = signal;
					signal.addEventListener("abort", () => resolve(undefined), { once: true });
				}),
		});
		await h.fire("agent_start");
		await tick();
		for (let index = 0; index < 40; index += 1) h.fire("agent_end");
		const shutdown = h.fire("session_shutdown");
		expect(h.fire("session_shutdown")).toBe(shutdown);
		h.fire("agent_start");
		h.fire("agent_settled");
		h.fire("tool_execution_start", { toolName: "bash" });
		expect(activeSignal?.aborted).toBe(true);
		await shutdown;
		expect(h.publications).toHaveLength(41);
		expect(h.deliveries).toHaveLength(1);
		expect(h.abandoned).toHaveLength(40);
		expect(h.spawn).not.toHaveBeenCalled();
		expect(h.timerCount()).toBe(0);
		await h.dispose();
	});

	it("waits for pending publications and flushes owed settlement with captured reply and transcript", async () => {
		const publication = deferred();
		const h = createPiLifecycleClockHarness({ publish: () => publication.promise });
		h.fire("session_start");
		h.fire("agent_start");
		h.bus.emit("subagent:async-started", { id: "worker" });
		h.fire("agent_end", { messages: [{ role: "assistant", content: "**Synthetic final**\n\n- retained" }] });
		h.fire("agent_settled");
		h.context.sessionManager.getSessionId = () => "changed";
		h.context.sessionManager.getSessionFile = () => "/changed.jsonl";
		let finished = false;
		const shutdown = Promise.resolve(h.fire("session_shutdown")).then(() => {
			finished = true;
		});
		await tick();
		expect(finished).toBe(false);
		expect(h.publications).toHaveLength(1);
		expect(h.listenerCount()).toBe(0);
		publication.resolve();
		await shutdown;
		expect(h.publications.at(-1)).toMatchObject({
			event: "to_review",
			metadata: {
				hookEventName: "AgentSettled",
				turnId: "turn-1",
				sessionId: "pi-session-1",
				transcriptPath: "/sessions/pi-session-1.json",
				finalMessage: "**Synthetic final**\n\n- retained",
			},
		});
		expect(h.abandoned).toHaveLength(5);
		expect(h.deliveries).toHaveLength(0);
		await h.dispose();
	});

	it("retries a swallowed transient publication error once at shutdown with the same frozen request", async () => {
		let attempts = 0;
		const h = createPiLifecycleClockHarness({
			publish: async () => {
				if (++attempts === 1) throw new Error("synthetic disk failure");
			},
		});
		// Pi catches handler rejection, reports it, and can still process.exit(0).
		await Promise.resolve(h.fire("agent_start")).catch(() => {});
		const failed = h.publications[0];
		await h.fire("session_shutdown");
		expect(attempts).toBe(2);
		expect(h.publications[1]).toBe(failed);
		expect(h.abandoned).toEqual([failed]);
		expect(h.deliveries).toEqual([]);
		await h.dispose();
	});

	it.each([
		{ code: "ENOSPC", reason: "ENOSPC" },
		{ code: "EACCES", reason: "EACCES" },
		{ code: "EPERM", reason: "EPERM" },
		{ code: "missing-identity", reason: "MISSING_REPLAY_IDENTITY" },
		{ code: "SENSITIVE_PROMPT_REPLY_TOKEN_CREDENTIAL", reason: "UNKNOWN_PUBLICATION_FAILURE" },
		{ code: "throwing-getter", reason: "UNKNOWN_PUBLICATION_FAILURE" },
	])("exposes only an allowlisted $reason for publication and shutdown failure ($code)", async ({ code, reason }) => {
		const sensitive = "SENSITIVE_PROMPT_REPLY_TOKEN_CREDENTIAL";
		const raw = Object.assign(
			code === "missing-identity" ? new HookPublicationUnavailableError(sensitive) : new Error(sensitive),
			{ code, name: sensitive, path: `/private/${sensitive}`, token: sensitive },
		);
		if (code === "throwing-getter") {
			Object.defineProperty(raw, "code", {
				get() {
					throw new Error(sensitive);
				},
			});
		}
		const h = createPiLifecycleClockHarness({
			publish: async () => {
				throw raw;
			},
		});
		const callbackError: unknown = await Promise.resolve(h.fire("agent_start")).catch((error: unknown) => error);
		expect(String(callbackError)).toBe(
			`Error: Quarterdeck could not publish a Pi lifecycle hook for replay; hook is unprotected [${reason}].`,
		);
		const shutdown = h.fire("session_shutdown");
		const shutdownError: unknown = await Promise.resolve(shutdown).catch((error: unknown) => error);
		expect(String(shutdownError)).toBe(
			`Error: Quarterdeck could not publish every Pi lifecycle hook for replay; some hooks are unprotected [${reason}].`,
		);
		expect(h.diagnostics.error.mock.calls).toEqual([
			[`Quarterdeck could not publish a Pi lifecycle hook for replay. [${reason}]`],
		]);
		const visible = [String(callbackError), String(shutdownError), ...h.diagnostics.error.mock.calls.flat()].join(
			"\n",
		);
		expect(visible).not.toContain(sensitive);
		expect(visible).not.toContain("/private/");
		expect(h.publications).toHaveLength(2);
		expect(h.publications[1]).toBe(h.publications[0]);
		expect(h.fire("session_shutdown")).toBe(shutdown);
		expect(h.deliveries).toEqual([]);
		await h.dispose().catch(() => {});
	});

	it("reads an allowlisted errno only once, never a changed getter's sensitive second value", async () => {
		const sensitive = "SENSITIVE_SECOND_ERRNO_READ";
		let reads = 0;
		const raw = Object.defineProperty(new Error(sensitive), "code", {
			get() {
				return ++reads === 1 ? "ENOSPC" : sensitive;
			},
		});
		const h = createPiLifecycleClockHarness({
			publish: async () => {
				throw raw;
			},
		});
		await expect(h.fire("agent_start")).rejects.toThrow("[ENOSPC]");
		expect(reads).toBe(1);
		await expect(h.fire("session_shutdown")).rejects.toThrow("[UNKNOWN_PUBLICATION_FAILURE]");
		expect(reads).toBe(2);
		expect(h.diagnostics.error.mock.calls.flat().join("\n")).not.toContain(sensitive);
		await h.dispose().catch(() => {});
	});

	it("never reports durable success after persistent publication failure", async () => {
		const requests: RuntimeHookIngestRequest[] = [];
		const h = createPiLifecycleClockHarness({
			publish: async (request) => {
				requests.push(request);
				throw new Error("synthetic persistent failure");
			},
		});
		await expect(h.fire("agent_start")).rejects.toThrow("hook is unprotected");
		const shutdown = h.fire("session_shutdown");
		await expect(shutdown).rejects.toThrow("could not publish every Pi lifecycle hook");
		expect(h.fire("session_shutdown")).toBe(shutdown);
		expect(requests).toHaveLength(2);
		expect(requests[1]).toBe(requests[0]);
		expect(h.deliveries).toEqual([]);
		expect(h.abandoned).toEqual([]);
		expect(h.timerCount()).toBe(0);
		await h.dispose().catch(() => {});
	});
});
