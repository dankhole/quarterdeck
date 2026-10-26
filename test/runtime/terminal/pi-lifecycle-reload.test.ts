import { afterEach, describe, expect, it, vi } from "vitest";

import type { RuntimeHookIngestRequest } from "../../../src/core/api/task-session";
import { compareSameProducerHookDeliveries } from "../../../src/hook-delivery-order";
import {
	commitHookEventOrder,
	createHookEventOrderState,
	evaluateHookEventOrder,
} from "../../../src/terminal/hook-event-order";
import type { PtySession } from "../../../src/terminal/pty-session";
import { createActiveProcessState, createProcessEntry } from "../../../src/terminal/session-manager-types";
import { InMemorySessionSummaryStore } from "../../../src/terminal/session-summary-store";
import { SessionTransitionController } from "../../../src/terminal/session-transition-controller";
import { createPiLifecycleClockHarness } from "../../utilities/pi-lifecycle-clock-harness";

const identity = { projectId: "reload-project", taskId: "reload-task", sessionInstanceId: "reload-launch" };

function createIngestHarness() {
	const store = new InMemorySessionSummaryStore();
	store.ensureEntry(identity.taskId);
	store.update(identity.taskId, {
		agentId: "pi",
		sessionInstanceId: identity.sessionInstanceId,
		resumeSessionId: "pi-session-1",
		pid: 1234,
		state: "awaiting_review",
		reviewReason: "unconfirmed",
	});
	const entry = createProcessEntry(identity.taskId);
	entry.active = createActiveProcessState({
		session: { pid: 1234, wasInterrupted: () => false } as unknown as PtySession,
		sessionInstanceId: identity.sessionInstanceId,
		agentId: "pi",
		cols: 120,
		rows: 40,
		willAutoTrust: false,
	});
	entry.hookEventOrder = createHookEventOrderState(identity.sessionInstanceId);
	const controller = new SessionTransitionController(store, new Map([[identity.taskId, entry]]));
	const accepted: RuntimeHookIngestRequest[] = [];
	function ingest(request: RuntimeHookIngestRequest) {
		expect(evaluateHookEventOrder(entry.hookEventOrder, request)).toEqual({ accepted: true });
		const result = controller.applyTransitionEvent(entry, {
			type: "provider.hook",
			event: request.event,
			metadata: request.metadata,
			occurredAt: request.delivery?.occurredAt,
			deliveryId: request.delivery?.id,
		});
		commitHookEventOrder(entry.hookEventOrder, request, {
			advanceTurn: result?.hookMetadataMode === "apply" || result?.hookOrderingMode === "advance",
		});
		if (request.event === "to_review" && request.metadata?.finalMessage) {
			store.appendCompletedResponse(identity.taskId, {
				text: request.metadata.finalMessage,
				capturedAt: request.delivery?.occurredAt ?? 0,
			});
		}
		accepted.push(request);
	}
	return { ingest, accepted, summary: () => store.getSummary(identity.taskId) };
}

afterEach(() => vi.restoreAllMocks());

describe("Pi launch-scoped delivery across separately evaluated modules", () => {
	it.each(["healthy", "pending"] as const)(
		"preserves reply/order across a %s reload without slowing a drained healthy launch",
		async (scenario) => {
			vi.spyOn(Date, "now").mockReturnValue(123_456);
			const registry = new Map<string, unknown>();
			const runtime = createIngestHarness();
			const pending = new Map<string, RuntimeHookIngestRequest>();
			const first = createPiLifecycleClockHarness({
				deliveryRegistry: registry,
				launchIdentity: identity,
				publish: async (request) => {
					pending.set(request.delivery?.id ?? "", request);
				},
				deliver: async (request) => {
					if (scenario === "pending" && request.event === "to_review") return "deferred";
					runtime.ingest(request);
					pending.delete(request.delivery?.id ?? "");
				},
			});
			await first.fire("agent_start");
			await first.fire("agent_end", {
				messages: [{ role: "assistant", content: "Old run reply survives /reload" }],
			});
			await first.fire("agent_settled");
			await first.drain();
			await first.fire("session_shutdown");
			const oldSettlement = first.publications.at(-1);
			expect(oldSettlement?.metadata?.hookEventName).toBe("AgentSettled");
			// A fresh VM evaluates the emitted module after shutdown, exactly the
			// boundary that a same-module session_start test cannot establish.
			const second = createPiLifecycleClockHarness({
				deliveryRegistry: registry,
				launchIdentity: identity,
				runIdPrefix: "reloaded-turn-",
				publish: async (request) => {
					pending.set(request.delivery?.id ?? "", request);
				},
				deliver: async (request) => {
					runtime.ingest(request);
					pending.delete(request.delivery?.id ?? "");
				},
			});
			await second.fire("session_start");
			await second.fire("agent_start");
			await second.drain();
			const newStart = second.publications.at(-1);
			expect(
				compareSameProducerHookDeliveries(oldSettlement?.delivery?.id ?? "", newStart?.delivery?.id ?? ""),
			).toBeLessThan(0);
			expect(newStart?.delivery?.occurredAt).toBe(123_456);
			if (scenario === "pending") {
				expect(second.deliveries).toEqual([]);
				expect(runtime.summary()?.completedResponses).toEqual([]);
				for (const request of [...pending.values()].sort(
					(left, right) =>
						compareSameProducerHookDeliveries(left.delivery?.id ?? "", right.delivery?.id ?? "") ?? 0,
				)) {
					runtime.ingest(request);
				}
			} else {
				expect(second.deliveries.map((request) => request.metadata?.hookEventName)).toEqual([
					"session_meta",
					"AgentStart",
				]);
				expect(pending.size).toBe(0);
			}
			expect(runtime.accepted.at(-1)?.metadata?.turnId).toBe("reloaded-turn-1");
			expect(runtime.summary()).toMatchObject({
				state: "running",
				completedResponses: [{ text: "Old run reply survives /reload" }],
			});
			await first.dispose();
			await second.dispose();
		},
	);

	it("retains an unpublished failed settlement through swallowed shutdown failure and retries it before the new module's start", async () => {
		const registry = new Map<string, unknown>();
		const first = createPiLifecycleClockHarness({
			deliveryRegistry: registry,
			launchIdentity: identity,
			publish: async (request) => {
				if (request.event === "to_review")
					throw Object.assign(new Error("private disk payload"), { code: "ENOSPC" });
			},
		});
		await first.fire("agent_start");
		await first.fire("agent_end", { messages: [{ role: "assistant", content: "Unpublished old reply" }] });
		await expect(first.fire("agent_settled")).rejects.toThrow("[ENOSPC]");
		const failed = first.publications.at(-1);
		// Pi catches this too and reimports despite the failed shutdown hook.
		await expect(first.fire("session_shutdown")).rejects.toThrow("[ENOSPC]");
		const second = createPiLifecycleClockHarness({
			deliveryRegistry: registry,
			launchIdentity: identity,
			runIdPrefix: "reloaded-turn-",
		});
		await second.fire("session_start");
		await second.fire("agent_start");
		await second.drain();
		expect(second.publications[0]).toBe(failed);
		expect(second.publications[0]?.metadata?.finalMessage).toBe("Unpublished old reply");
		expect(second.deliveries).toEqual(second.publications);
		expect(second.publications.map((request) => request.metadata?.hookEventName)).toEqual([
			"AgentSettled",
			"session_meta",
			"AgentStart",
		]);
		expect(
			compareSameProducerHookDeliveries(failed?.delivery?.id ?? "", second.publications.at(-1)?.delivery?.id ?? ""),
		).toBeLessThan(0);
		await first.dispose().catch(() => {});
		await second.dispose();
	});

	it.each(["projectId", "taskId", "sessionInstanceId"] as const)(
		"does not reuse a producer or replay fence across a different %s",
		async (field) => {
			const registry = new Map<string, unknown>();
			const first = createPiLifecycleClockHarness({
				deliveryRegistry: registry,
				launchIdentity: identity,
				deliver: async () => "deferred",
			});
			await first.fire("agent_start");
			await first.drain();
			await first.fire("session_shutdown");
			const second = createPiLifecycleClockHarness({
				deliveryRegistry: registry,
				launchIdentity: { ...identity, [field]: "other-launch" },
			});
			await second.fire("agent_start");
			await second.drain();
			expect(second.deliveries).toHaveLength(1);
			expect(
				compareSameProducerHookDeliveries(
					first.publications[0]?.delivery?.id ?? "",
					second.publications[0]?.delivery?.id ?? "",
				),
			).toBeNull();
			expect(registry.size).toBe(2);
			await first.dispose();
			await second.dispose();
		},
	);

	it("bounds the launch registry without silently evicting retained predecessors", async () => {
		const registry = new Map<string, unknown>();
		const modules = Array.from({ length: 16 }, (_, index) =>
			createPiLifecycleClockHarness({
				deliveryRegistry: registry,
				launchIdentity: { ...identity, sessionInstanceId: `launch-${index}` },
			}),
		);
		expect(() => createPiLifecycleClockHarness({ deliveryRegistry: registry, launchIdentity: identity })).toThrow(
			"launch-scope capacity exceeded",
		);
		expect(registry.size).toBe(16);
		for (const module of modules) await module.dispose();
	});
});
