import { afterEach, describe, expect, it } from "vitest";

import {
	createPiLifecycleClockHarness,
	hookFlag,
	PI_BACKGROUND_GRACE_MS,
	PI_BACKGROUND_HOLD_MS,
	type PiLifecycleClockHarness,
} from "../../utilities/pi-lifecycle-clock-harness";

const CREATED = "subagents:created";
const STARTED = "subagents:started";
const COMPLETED = "subagents:completed";
const FAILED = "subagents:failed";
const NICO_START = "subagent:async-started";
const NICO_COMPLETE = "subagent:async-complete";
const harnesses: PiLifecycleClockHarness[] = [];

async function setup(options: Parameters<typeof createPiLifecycleClockHarness>[0] = {}) {
	const harness = createPiLifecycleClockHarness(options);
	harnesses.push(harness);
	await harness.boot();
	return harness;
}

function record(id: string, fields: Record<string, unknown> = {}) {
	return {
		id,
		type: "general-purpose",
		description: "Synthetic work",
		status: "running",
		startedAt: 1_000_000,
		isBackground: true,
		blocking: false,
		...fields,
	};
}

function created(h: PiLifecycleClockHarness, id: string) {
	// Real created events follow record registration; preserve explicit test
	// records (queued, terminal, foreground or malformed) rather than replacing.
	if (!h.records.has(id)) h.records.set(id, record(id));
	h.bus.emit(CREATED, { id, type: "general-purpose", description: "Synthetic work", isBackground: true });
}

function started(h: PiLifecycleClockHarness, id: string) {
	h.bus.emit(STARTED, { id, type: "general-purpose", description: "Synthetic work" });
}

function finish(h: PiLifecycleClockHarness, id: string, status = "completed") {
	const old = h.records.get(id);
	h.records.set(id, { ...(typeof old === "object" && old ? old : record(id)), status, completedAt: 1_000_100 });
	h.bus.emit(status === "completed" ? COMPLETED : FAILED, {
		id,
		status,
		result: "Child-only result",
		error: "Child error",
	});
}

function rootEnd(h: PiLifecycleClockHarness, { aborted = false, failed = false, text = "Root final answer" } = {}) {
	h.fire("agent_end", {
		messages: [{ role: "assistant", stopReason: failed ? "error" : "stop", content: [{ type: "text", text }] }],
	});
	h.fire("agent_settled", { aborted });
}

function pending(h: PiLifecycleClockHarness) {
	return h.calls.filter((args) => hookFlag(args, "--hook-event-name") === "AgentSettledBackgroundPending");
}

async function expectGraceReview(h: PiLifecycleClockHarness) {
	await h.drain();
	expect(h.reviews()).toHaveLength(0);
	await h.advance(PI_BACKGROUND_GRACE_MS - 1);
	expect(h.reviews()).toHaveLength(0);
	await h.advance(1);
	expect(h.reviews()).toHaveLength(1);
	expect(hookFlag(h.reviews()[0] ?? [], "--hook-event-name")).toBe("AgentSettled");
}

afterEach(async () => {
	for (const harness of harnesses.splice(0)) await harness.dispose();
});

describe("Pi optional integrations: emitted asset with isolated clock and transport", () => {
	describe.each([true, false])("plain Pi with bus=%s", (bus) => {
		it.each([
			{ aborted: false, failed: false, hook: "AgentSettled" },
			{ aborted: true, failed: false, hook: "Interrupt" },
			{ aborted: false, failed: true, hook: "StopFailure" },
		])("preserves root $hook, final text and zero optional background work", async ({ aborted, failed, hook }) => {
			const h = await setup({ bus });
			h.fire("agent_start");
			rootEnd(h, { aborted, failed });
			await h.drain();
			expect(h.hooks()).toEqual(["AgentStart", "AgentEnd", hook]);
			expect(hookFlag(h.reviews()[0] ?? [], "--final-message")).toBe(
				aborted || failed ? undefined : "Root final answer",
			);
			expect(h.timerCount()).toBe(0);
			expect(h.manager.getRecord).not.toHaveBeenCalled();
			expect(h.manager.hasRunning).not.toHaveBeenCalled();
			expect(h.manager.spawn).not.toHaveBeenCalled();
			expect(h.manager.waitForAll).not.toHaveBeenCalled();
			expect(h.context.ui.notify).not.toHaveBeenCalled();
			await h.advance(PI_BACKGROUND_HOLD_MS + PI_BACKGROUND_GRACE_MS);
			expect(h.hooks()).toEqual(["AgentStart", "AgentEnd", hook]);
		});
	});

	it("does not wire optional listeners, probe the global manager or start timers before a lifecycle binding", async () => {
		const h = createPiLifecycleClockHarness();
		harnesses.push(h);
		expect(h.listenerCount()).toBe(0);
		created(h, "filtered-out");
		started(h, "filtered-out");
		await h.advance(PI_BACKGROUND_HOLD_MS);
		expect(h.calls).toEqual([]);
		expect(h.timerCount()).toBe(0);
		expect(h.manager.getRecord).not.toHaveBeenCalled();
	});

	it("ignores unrelated and malformed events without spawning, probing or leaking activity", async () => {
		const h = await setup();
		h.fire("agent_start");
		for (const channel of [CREATED, STARTED, COMPLETED, FAILED, NICO_START, NICO_COMPLETE]) {
			for (const payload of [null, "noise", {}, { id: "" }, { id: 42 }, { id: "   " }]) h.bus.emit(channel, payload);
		}
		h.bus.emit("subagents:rpc:spawn:reply:unrelated", { success: true, data: { id: "unobserved" } });
		rootEnd(h);
		await h.drain();
		expect(h.hooks()).toEqual(["AgentStart", "AgentEnd", "AgentSettled"]);
		expect(h.timerCount()).toBe(0);
		expect(h.manager.getRecord).not.toHaveBeenCalled();
	});

	it.each(["immediate", "queued"])("tracks %s created/started order and waits for both children", async (order) => {
		const h = await setup();
		h.fire("agent_start");
		for (const id of ["one", "two"]) {
			h.records.set(id, record(id, { status: order === "queued" ? "queued" : "running" }));
			if (order === "immediate") started(h, id);
			created(h, id);
			if (order === "queued") {
				h.records.set(id, record(id));
				started(h, id);
			}
		}
		rootEnd(h);
		await h.drain();
		expect(hookFlag(pending(h)[0] ?? [], "--activity-text")).toContain("2 background subagents running");
		finish(h, "one");
		await h.advance(PI_BACKGROUND_GRACE_MS * 2);
		expect(h.reviews()).toHaveLength(0);
		finish(h, "two");
		await expectGraceReview(h);
		expect(hookFlag(h.reviews()[0] ?? [], "--final-message")).toBe("Root final answer");
		expect(hookFlag(h.reviews()[0] ?? [], "--turn-id")).toBe(hookFlag(h.calls[0] ?? [], "--turn-id"));
		expect(hookFlag(h.reviews()[0] ?? [], "--session-id")).toBe("pi-session-1");
		expect(h.timerCount()).toBe(0);
	});

	it.each(["completed", "error", "stopped", "aborted"])(
		"handles child %s once without substituting child text",
		async (status) => {
			const h = await setup();
			h.fire("agent_start");
			h.records.set("one", record("one"));
			created(h, "one");
			created(h, "one");
			started(h, "one");
			started(h, "one");
			rootEnd(h);
			await h.drain();
			expect(hookFlag(pending(h)[0] ?? [], "--activity-text")).toContain("1 background subagent running");
			finish(h, "one", status);
			finish(h, "one", status);
			// Late duplicate registration must not resurrect the finished generation.
			created(h, "one");
			await expectGraceReview(h);
			await h.advance(PI_BACKGROUND_GRACE_MS * 2);
			expect(h.reviews()).toHaveLength(1);
			expect(hookFlag(h.reviews()[0] ?? [], "--final-message")).toBe("Root final answer");
		},
	);

	it("does not resurrect an immediate startup failure whose terminal event preceded created", async () => {
		const h = await setup();
		h.fire("agent_start");
		finish(h, "startup-error", "error");
		created(h, "startup-error");
		rootEnd(h);
		await h.drain();
		expect(h.hooks()).toEqual(["AgentStart", "AgentEnd", "AgentSettled"]);
		expect(h.timerCount()).toBe(0);
	});

	it.each(["aborted", "error", "stopped"])(
		"reconciles queued %s through documented getRecord without a terminal event",
		async (status) => {
			const h = await setup();
			h.fire("agent_start");
			h.records.set("queued", record("queued", { status: "queued" }));
			created(h, "queued");
			rootEnd(h);
			await h.drain();
			expect(pending(h)).toHaveLength(1);
			h.records.set("queued", record("queued", { status, completedAt: 1_000_100 }));
			await h.advance(PI_BACKGROUND_GRACE_MS * 4);
			expect(h.reviews()).toHaveLength(1);
			expect(h.manager.getRecord).toHaveBeenCalledWith("queued");
			expect(h.manager.getRecord.mock.calls.every(([id]) => id === "queued")).toBe(true);
			expect(h.manager.hasRunning).not.toHaveBeenCalled();
			expect(h.manager.spawn).not.toHaveBeenCalled();
			expect(h.manager.waitForAll).not.toHaveBeenCalled();
			expect(h.bus.emit.mock.calls.every(([channel]) => channel === CREATED)).toBe(true);
			expect(h.timerCount()).toBe(0);
		},
	);

	it("reconciles a queued cancellation already terminal at root settlement", async () => {
		const h = await setup();
		h.fire("agent_start");
		h.records.set("queued", record("queued", { status: "queued" }));
		created(h, "queued");
		h.records.set("queued", record("queued", { status: "aborted" }));
		rootEnd(h);
		await h.advance(PI_BACKGROUND_GRACE_MS * 2);
		expect(h.reviews()).toHaveLength(1);
		expect(h.timerCount()).toBe(0);
	});

	it.each([
		null,
		{},
		{ getRecord: 42 },
		{
			getRecord: () => {
				throw new Error("Registry unavailable");
			},
		},
	])("ignores new background admission without a usable registry (%j)", async (registry) => {
		const h = await setup({ registry });
		h.fire("agent_start");
		created(h, "unverified");
		started(h, "unverified");
		rootEnd(h);
		await h.advance(PI_BACKGROUND_GRACE_MS * 4);
		expect(pending(h)).toHaveLength(0);
		expect(h.hooks()).toEqual(["AgentStart", "AgentEnd", "AgentSettled"]);
		expect(h.timerCount()).toBe(0);
	});

	it.each(["absent", "throwing", "malformed"])(
		"keeps admitted work pending after its registry becomes %s",
		async (kind) => {
			const h = await setup();
			h.fire("agent_start");
			created(h, "admitted");
			h.setRegistry(
				kind === "absent"
					? undefined
					: kind === "malformed"
						? {}
						: {
								getRecord() {
									throw new Error("Registry unavailable after admission");
								},
							},
			);
			rootEnd(h);
			await h.advance(PI_BACKGROUND_GRACE_MS * 4);
			expect(pending(h)).toHaveLength(1);
			expect(h.reviews()).toHaveLength(0);
			finish(h, "admitted");
			await expectGraceReview(h);
		},
	);

	it.each([
		undefined,
		{},
		record("wrong"),
		record("one", { status: "unknown" }),
		record("one", { blocking: "false" }),
		record("one", { isBackground: "true" }),
		record("one", { blocking: true }),
		record("one", { parentAgentId: "owner" }),
		record("one", { workflowId: "owner" }),
		record("one", { status: "completed" }),
	])("rejects new admission for unusable, owned, blocking or terminal records (%j)", async (nativeRecord) => {
		const h = await setup();
		h.fire("agent_start");
		h.records.set("one", nativeRecord);
		created(h, "one");
		started(h, "one");
		rootEnd(h);
		await h.advance(PI_BACKGROUND_GRACE_MS * 4);
		expect(pending(h)).toHaveLength(0);
		expect(h.reviews()).toHaveLength(1);
		expect(h.timerCount()).toBe(0);
	});

	it.each([undefined, {}, { id: "wrong", status: "completed" }, { id: "one", status: "unknown" }])(
		"does not infer completion from missing or malformed records (%j)",
		async (value) => {
			const h = await setup();
			h.fire("agent_start");
			created(h, "one");
			h.records.set("one", value);
			rootEnd(h);
			await h.advance(PI_BACKGROUND_GRACE_MS * 4);
			expect(h.reviews()).toHaveLength(0);
			finish(h, "one");
			await expectGraceReview(h);
		},
	);

	it("accepts a same-ID resumed generation without double-counting its started/created pair", async () => {
		const h = await setup();
		h.fire("agent_start");
		h.records.set("same", record("same"));
		started(h, "same");
		created(h, "same");
		finish(h, "same");
		h.records.set("same", record("same", { startedAt: 1_000_200 }));
		started(h, "same");
		created(h, "same");
		rootEnd(h);
		await h.drain();
		expect(hookFlag(pending(h)[0] ?? [], "--activity-text")).toContain("1 background subagent running");
		await h.advance(PI_BACKGROUND_GRACE_MS * 2);
		expect(h.reviews()).toHaveLength(0);
		finish(h, "same");
		await expectGraceReview(h);
	});

	it("reconciles silent cancellation of a same-ID queued resume after its old delayed completion", async () => {
		const h = await setup();
		h.fire("agent_start");
		// With one background slot, B queues behind A. A's old run becomes
		// terminal before its asynchronous cleanup emits completed.
		h.records.set("a", record("a"));
		started(h, "a");
		created(h, "a");
		h.records.set("b", record("b", { status: "queued" }));
		created(h, "b");
		rootEnd(h);
		await h.drain();
		expect(hookFlag(pending(h)[0] ?? [], "--activity-text")).toContain("2 background subagents running");
		h.records.set("a", record("a", { status: "completed", completedAt: 1_000_100 }));
		await h.advance(200);
		// Resume reuses A's ID but queues a new generation while the old
		// cleanup/completion is still in flight. Do not retain its started flag.
		h.records.set("a", record("a", { status: "queued", startedAt: 1_000_200 }));
		created(h, "a");
		h.bus.emit(COMPLETED, { id: "a", status: "completed", result: "Old A result" });
		h.records.set("a", record("a", { status: "aborted", startedAt: 1_000_200, completedAt: 1_000_300 }));
		// Queued cancellation emits no event. B then takes the slot and ends;
		// A must still be eligible for the read-only queued reconciliation.
		h.records.set("b", record("b", { startedAt: 1_000_300 }));
		started(h, "b");
		finish(h, "b");
		await h.drain();
		expect(h.reviews()).toHaveLength(0);
		await h.advance(PI_BACKGROUND_GRACE_MS * 4);
		expect(h.reviews()).toHaveLength(1);
		expect(hookFlag(h.reviews()[0] ?? [], "--final-message")).toBe("Root final answer");
		expect(hookFlag(h.reviews()[0] ?? [], "--turn-id")).toBe("turn-1");
		expect(h.timerCount()).toBe(0);
	});

	it("ignores late terminal events for a previous generation while the native record is running again", async () => {
		const h = await setup();
		h.fire("agent_start");
		h.records.set("same", record("same"));
		started(h, "same");
		created(h, "same");
		finish(h, "same");
		h.records.set("same", record("same", { startedAt: 1_000_200 }));
		started(h, "same");
		created(h, "same");
		h.bus.emit(COMPLETED, { id: "same", status: "completed", result: "Previous generation" });
		rootEnd(h);
		await h.advance(PI_BACKGROUND_GRACE_MS * 2);
		expect(pending(h)).toHaveLength(1);
		expect(h.reviews()).toHaveLength(0);
		finish(h, "same");
		await expectGraceReview(h);
	});

	it("keeps terminal-before-created inert even when the manager is genuinely absent", async () => {
		const h = await setup();
		h.setRegistry(undefined);
		h.fire("agent_start");
		h.bus.emit(FAILED, { id: "startup-error", status: "error" });
		created(h, "startup-error");
		rootEnd(h);
		await h.drain();
		expect(pending(h)).toHaveLength(0);
		expect(h.reviews()).toHaveLength(1);
		expect(h.timerCount()).toBe(0);
	});

	it("reconciles native queued steered terminal status without inventing a separate event", async () => {
		const h = await setup();
		h.fire("agent_start");
		h.records.set("steered", record("steered", { status: "queued" }));
		created(h, "steered");
		rootEnd(h);
		h.records.set("steered", record("steered", { status: "steered" }));
		await h.advance(PI_BACKGROUND_GRACE_MS * 4);
		expect(h.reviews()).toHaveLength(1);
		expect(h.timerCount()).toBe(0);
	});

	it.each(["queued-started", "immediate", "handoff", "queued-running-record"])(
		"waits for terminal event after %s worker is marked stopped during slow cleanup",
		async (order) => {
			const h = await setup();
			h.fire("agent_start");
			if (order.startsWith("queued")) {
				h.records.set("slow-stop", record("slow-stop", { status: "queued" }));
				created(h, "slow-stop");
			} else {
				h.records.set("slow-stop", record("slow-stop", { blocking: order === "handoff" }));
				started(h, "slow-stop");
			}
			h.records.set("slow-stop", record("slow-stop"));
			if (order === "queued-started") started(h, "slow-stop");
			else if (order === "queued-running-record") await h.advance(1_000);
			else created(h, "slow-stop");
			// Tintinweb writes stopped before session/worktree cleanup and only
			// emits failed after cleanup. A native status read cannot settle this.
			h.records.set("slow-stop", record("slow-stop", { status: "stopped" }));
			rootEnd(h);
			await h.drain();
			expect(pending(h)).toHaveLength(1);
			const lookupsAtSettle = h.manager.getRecord.mock.calls.length;
			await h.advance(PI_BACKGROUND_GRACE_MS * 4);
			expect(h.reviews()).toHaveLength(0);
			expect(h.manager.getRecord).toHaveBeenCalledTimes(lookupsAtSettle);
			finish(h, "slow-stop", "stopped");
			await expectGraceReview(h);
			expect(h.timerCount()).toBe(0);
		},
	);

	it("keeps still-pending children across root turns and settles only the latest final", async () => {
		const h = await setup();
		h.fire("agent_start");
		created(h, "one");
		rootEnd(h);
		h.fire("agent_start");
		rootEnd(h, { text: "Newest root final" });
		finish(h, "one");
		await expectGraceReview(h);
		expect(pending(h)).toHaveLength(2);
		expect(hookFlag(h.reviews()[0] ?? [], "--turn-id")).toBe("turn-2");
		expect(hookFlag(h.reviews()[0] ?? [], "--final-message")).toBe("Newest root final");
	});

	it("ignores foreground started events until an explicit background handoff", async () => {
		const h = await setup();
		h.fire("agent_start");
		h.records.set("foreground", record("foreground", { isBackground: false, blocking: true }));
		started(h, "foreground");
		rootEnd(h);
		await h.drain();
		expect(pending(h)).toHaveLength(0);
		expect(h.reviews()).toHaveLength(1);
		h.fire("agent_start");
		h.records.set("foreground", record("foreground", { isBackground: true, blocking: false }));
		created(h, "foreground");
		rootEnd(h);
		await h.drain();
		expect(pending(h)).toHaveLength(1);
		finish(h, "foreground");
		await h.advance(PI_BACKGROUND_GRACE_MS);
		expect(h.reviews()).toHaveLength(2);
	});

	it.each([true, false, undefined])(
		"tracks RPC started-only detached records (isBackground=%s, blocking=false)",
		async (isBackground) => {
			const h = await setup();
			h.fire("agent_start");
			h.records.set("rpc", record("rpc", { isBackground, blocking: false }));
			started(h, "rpc");
			rootEnd(h);
			await h.drain();
			expect(pending(h)).toHaveLength(1);
			finish(h, "rpc");
			await expectGraceReview(h);
		},
	);

	it.each([{ parentAgentId: "parent" }, { workflowId: "workflow" }])(
		"excludes owned child records (%j)",
		async (ownership) => {
			const h = await setup();
			h.fire("agent_start");
			h.records.set("nested", record("nested", ownership));
			started(h, "nested");
			rootEnd(h);
			await h.drain();
			expect(pending(h)).toHaveLength(0);
			expect(h.reviews()).toHaveLength(1);
			expect(h.timerCount()).toBe(0);
		},
	);

	it("ignores stale session identities and malformed Tintinweb IDs before registry lookup", async () => {
		const h = await setup();
		h.records.set("foreign", record("foreign"));
		h.fire("agent_start");
		for (const channel of [CREATED, STARTED, COMPLETED, FAILED]) {
			h.bus.emit(channel, { id: "foreign", isBackground: true, sessionId: "another-session" });
			for (const id of [" padded ", "x".repeat(513)]) h.bus.emit(channel, { id, isBackground: true });
		}
		rootEnd(h);
		await h.drain();
		expect(h.manager.getRecord).not.toHaveBeenCalled();
		expect(h.reviews()).toHaveLength(1);
		expect(h.timerCount()).toBe(0);
	});

	it("does not trust a foreign global registry without local bus evidence", async () => {
		const h = await setup();
		h.records.set("foreign-running", record("foreign-running"));
		h.fire("agent_start");
		rootEnd(h);
		await h.drain();
		expect(h.manager.getRecord).not.toHaveBeenCalled();
		expect(pending(h)).toHaveLength(0);
		expect(h.reviews()).toHaveLength(1);
		expect(h.timerCount()).toBe(0);
	});

	it("isolates child buses/registries and never invents a root start from background evidence", async () => {
		const root = await setup();
		const child = await setup();
		created(child, "same");
		started(child, "same");
		await child.drain();
		expect(child.calls).toEqual([]);
		root.fire("agent_start");
		rootEnd(root);
		await root.drain();
		expect(root.hooks()).toEqual(["AgentStart", "AgentEnd", "AgentSettled"]);
		expect(root.manager.getRecord).not.toHaveBeenCalled();
		await child.dispose();
		expect(child.timerCount()).toBe(0);
	});

	it("keeps Nico and Tintinweb identities separate even when IDs collide", async () => {
		const h = await setup();
		h.fire("agent_start");
		h.bus.emit(NICO_START, { id: "same", sessionId: "pi-session-1" });
		created(h, "same");
		rootEnd(h);
		await h.drain();
		expect(hookFlag(pending(h)[0] ?? [], "--activity-text")).toContain("2 background subagents running");
		finish(h, "same");
		await h.advance(PI_BACKGROUND_GRACE_MS * 2);
		expect(h.reviews()).toHaveLength(0);
		h.bus.emit(NICO_COMPLETE, { id: "same", sessionId: "different-session", triggerTurn: false });
		await h.drain();
		expect(h.reviews()).toHaveLength(0);
		h.bus.emit(NICO_COMPLETE, { id: "same", sessionId: "/sessions/pi-session-1.json", triggerTurn: false });
		await h.drain();
		expect(h.reviews()).toHaveLength(1);
		expect(h.timerCount()).toBe(0);
	});

	it("allows Nico no-wake completion to flush promptly while Tintinweb always preserves notification grace", async () => {
		const h = await setup();
		h.fire("agent_start");
		created(h, "tintin");
		rootEnd(h);
		finish(h, "tintin");
		await expectGraceReview(h);
		h.fire("agent_start");
		h.bus.emit(NICO_START, { id: "nico" });
		rootEnd(h);
		h.bus.emit(NICO_COMPLETE, { id: "nico", triggerTurn: false });
		await h.drain();
		expect(h.reviews()).toHaveLength(2);
		expect(h.timerCount()).toBe(0);
	});

	it("re-arms busy grace, then flushes when native idle returns", async () => {
		const h = await setup();
		h.context.isIdle = () => false;
		h.fire("agent_start");
		created(h, "one");
		rootEnd(h);
		finish(h, "one");
		await h.advance(PI_BACKGROUND_GRACE_MS * 3);
		expect(h.reviews()).toHaveLength(0);
		h.context.isIdle = () => true;
		await h.advance(PI_BACKGROUND_GRACE_MS);
		expect(h.reviews()).toHaveLength(1);
		expect(h.timerCount()).toBe(0);
	});

	it("supersedes an old pending final on a real wake agent_start and preserves the new final", async () => {
		const h = await setup();
		h.fire("agent_start");
		created(h, "one");
		rootEnd(h);
		finish(h, "one");
		await h.advance(200); // Tintinweb completion outbox's ordinary idle notification hold.
		h.fire("agent_start");
		rootEnd(h, { text: "Wake answer" });
		await h.advance(PI_BACKGROUND_GRACE_MS * 2);
		expect(h.reviews()).toHaveLength(1);
		expect(hookFlag(h.reviews()[0] ?? [], "--final-message")).toBe("Wake answer");
		expect(hookFlag(h.reviews()[0] ?? [], "--turn-id")).toBe("turn-2");
		expect(h.timerCount()).toBe(0);
	});

	it.each([
		{ aborted: true, failed: false, hook: "Interrupt" },
		{ aborted: false, failed: true, hook: "StopFailure" },
	])("never defers root $hook behind Tintinweb work", async ({ aborted, failed, hook }) => {
		const h = await setup();
		h.fire("agent_start");
		created(h, "one");
		rootEnd(h, { aborted, failed });
		await h.drain();
		expect(pending(h)).toHaveLength(0);
		expect(hookFlag(h.reviews()[0] ?? [], "--hook-event-name")).toBe(hook);
		expect(hookFlag(h.reviews()[0] ?? [], "--final-message")).toBeUndefined();
		finish(h, "one");
		await h.advance(PI_BACKGROUND_GRACE_MS * 2);
		expect(h.reviews()).toHaveLength(1);
	});

	it.each(["session_start", "session_shutdown"])(
		"flushes old identity and cleans listeners/timers on %s",
		async (event) => {
			const h = await setup();
			h.fire("agent_start");
			created(h, "old");
			rootEnd(h);
			await h.drain();
			const staleCallbacks = h.bus.on.mock.calls.map(([, callback]) => callback);
			h.context.sessionManager.getSessionId = () => "replacement";
			h.context.sessionManager.getSessionFile = () => "/sessions/replacement.json";
			h.fire(event);
			await h.drain();
			expect(h.reviews()).toHaveLength(1);
			expect(hookFlag(h.reviews()[0] ?? [], "--session-id")).toBe("pi-session-1");
			expect(hookFlag(h.reviews()[0] ?? [], "--turn-id")).toBe("turn-1");
			expect(hookFlag(h.reviews()[0] ?? [], "--final-message")).toBe("Root final answer");
			for (const callback of staleCallbacks) callback({ id: "old", isBackground: true });
			await h.advance(PI_BACKGROUND_GRACE_MS * 2);
			expect(h.reviews()).toHaveLength(1);
			expect(h.timerCount()).toBe(0);
			if (event === "session_shutdown") expect(h.listenerCount()).toBe(0);
			else {
				h.fire("agent_start");
				rootEnd(h, { text: "Replacement answer" });
				await h.drain();
				expect(h.reviews()).toHaveLength(2);
				expect(hookFlag(h.reviews()[1] ?? [], "--session-id")).toBe("replacement");
			}
		},
	);

	it("reactivates once after shutdown, rejects retired IDs and accepts newly observed work", async () => {
		const h = await setup();
		const listenersBefore = h.listenerCount();
		h.fire("agent_start");
		created(h, "retired");
		rootEnd(h);
		h.fire("session_shutdown");
		await h.drain();
		expect(h.listenerCount()).toBe(0);
		h.fire("session_start");
		await h.drain();
		expect(h.listenerCount()).toBe(listenersBefore);
		h.calls.length = 0;
		created(h, "retired");
		h.fire("agent_start");
		created(h, "fresh");
		rootEnd(h);
		await h.drain();
		expect(hookFlag(pending(h)[0] ?? [], "--activity-text")).toContain("1 background subagent running");
		finish(h, "fresh");
		await expectGraceReview(h);
	});

	it.each(["missing-completion", "busy-grace"])(
		"bounds %s by the event-based hold cap, not reconciliation/grace ticks",
		async (mode) => {
			const h = await setup();
			h.context.isIdle = () => mode !== "busy-grace";
			h.fire("agent_start");
			created(h, "one");
			h.setRegistry(undefined);
			rootEnd(h);
			if (mode === "busy-grace") finish(h, "one");
			await h.advance(PI_BACKGROUND_HOLD_MS - 1);
			expect(h.reviews()).toHaveLength(0);
			await h.advance(1);
			expect(h.reviews()).toHaveLength(1);
			expect(hookFlag(h.reviews()[0] ?? [], "--final-message")).toBe("Root final answer");
			expect(h.timerCount()).toBe(0);
		},
	);
});
