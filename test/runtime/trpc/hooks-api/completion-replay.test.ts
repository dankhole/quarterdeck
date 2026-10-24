import { describe, expect, it, vi } from "vitest";

import type { RuntimeHookIngestRequest, RuntimeHookMetadata } from "../../../../src/core";
import { createPersistedHookTransition } from "../../../../src/hook-transition-outbox-core";
import { InMemorySessionSummaryStore } from "../../../../src/terminal";
import {
	commitHookEventOrder,
	createHookEventOrderState,
	createProviderHookOrderObservation,
	evaluateHookEventOrder,
} from "../../../../src/terminal/hook-event-order";
import { createMockManager, createSummary, createTestApi } from "./_helpers";

type Provider = "codex" | "claude" | "pi";
const providers = ["codex", "claude", "pi"] as const;
const olderReply = "The installed Tintinweb extension is available.";
const latestReply = "Pi shortcuts: use the shortcut help to inspect the supported key bindings.";

function createHarness(agentId: Provider) {
	const store = new InMemorySessionSummaryStore();
	store.ensureEntry("task-1");
	store.update(
		"task-1",
		createSummary({
			agentId,
			sessionInstanceId: "launch-1",
			nativeWorkEvidence: {
				provider: agentId,
				sessionInstanceId: "launch-1",
				providerSessionId: null,
				turnId: "turn-1",
				promptId: "prompt-1",
				hookEventName: agentId === "pi" ? "AgentStart" : "UserPromptSubmit",
				confirmedAt: 100,
			},
		}),
	);
	store.appendCompletedResponse("task-1", { text: olderReply, capturedAt: 1 });
	const manager = createMockManager({
		getSummary: store.getSummary.bind(store),
		appendCompletedResponse: store.appendCompletedResponse.bind(store),
		onChange: store.onChange.bind(store),
	});
	// Exercise real delivery deduplication and launch/turn/prompt fences rather
	// than teaching a mock which completion should win.
	const order = createHookEventOrderState("launch-1");
	manager.evaluateHookEventOrder = vi.fn((_taskId, input) => evaluateHookEventOrder(order, input));
	manager.commitHookEventOrder = vi.fn((taskId, input, advanceTurn) => {
		commitHookEventOrder(order, input, { advanceTurn });
		if (advanceTurn) store.recordProviderHookReceipt(taskId, createProviderHookOrderObservation(input));
	});
	manager.applyProviderHook = vi.fn((taskId, input) =>
		store.applySessionEvent(taskId, {
			type: "provider.hook",
			event: input.event,
			metadata: input.metadata,
			occurredAt: input.delivery?.occurredAt,
			sessionEvidence: "live",
		}),
	);
	const api = createTestApi(manager);
	let deliveryIndex = 0;
	function request(
		metadata: RuntimeHookMetadata = {},
		event: RuntimeHookIngestRequest["event"] = "to_review",
		occurredAt = 200,
	): RuntimeHookIngestRequest {
		deliveryIndex += 1;
		return {
			taskId: "task-1",
			projectId: "project-1",
			event,
			metadata: {
				source: agentId,
				sessionInstanceId: "launch-1",
				hookEventName: agentId === "pi" ? "AgentSettled" : "Stop",
				turnId: "turn-1",
				promptId: "prompt-1",
				...metadata,
			},
			delivery: {
				id: `00000000-0000-4000-8000-${String(deliveryIndex).padStart(12, "0")}`,
				occurredAt,
			},
		};
	}
	return { api, manager, store, request };
}

function replayRequest(input: RuntimeHookIngestRequest): RuntimeHookIngestRequest {
	const record = createPersistedHookTransition(input, 200);
	expect(record).not.toBeNull();
	if (!record) throw new Error("Expected a replayable completion");
	return record.request;
}

describe("completion response retention when the persisted replay wins delivery", () => {
	it.each(providers)("retains the newest %s reply before the full same-ID request arrives", async (provider) => {
		const { api, manager, store, request } = createHarness(provider);
		const original = request({ finalMessage: latestReply, conversationSummaryText: "Shorter synopsis" });

		await expect(api.ingest(replayRequest(original))).resolves.toEqual({ ok: true });
		const retained = store.getSummary("task-1")?.completedResponses;
		expect(retained?.map((entry) => entry.text)).toEqual([olderReply, latestReply]);
		expect(store.getSummary("task-1")?.state).toBe("awaiting_review");

		await expect(api.ingest(original)).resolves.toEqual({ ok: true });
		expect(manager.evaluateHookEventOrder).toHaveLastReturnedWith({ accepted: false, reason: "duplicate_delivery" });
		expect(manager.applyProviderHook).toHaveBeenCalledOnce();
		expect(store.getSummary("task-1")?.completedResponses).toEqual(retained);

		await api.ingest(
			request(
				{
					hookEventName: provider === "pi" ? "AgentStart" : "UserPromptSubmit",
					turnId: "turn-2",
					promptId: "prompt-2",
				},
				"to_in_progress",
				300,
			),
		);
		expect(store.getSummary("task-1")?.latestHookActivity?.finalMessage).toBeNull();
		expect(store.getSummary("task-1")?.completedResponses).toEqual(retained);

		// A delayed completion from the superseded turn/prompt must not restore
		// older content after the next turn has started.
		await api.ingest(replayRequest(request({ finalMessage: "A stale turn's answer." }, "to_review", 150)));
		expect(manager.evaluateHookEventOrder).toHaveLastReturnedWith(expect.objectContaining({ accepted: false }));
		expect(store.getSummary("task-1")?.completedResponses).toEqual(retained);
	});

	it.each(providers)("retains the %s legacy summary fallback when finalMessage is blank", async (provider) => {
		const { api, store, request } = createHarness(provider);
		const original = request({ finalMessage: "  \n ", conversationSummaryText: `  ${latestReply}  ` });
		await expect(api.ingest(replayRequest(original))).resolves.toEqual({ ok: true });
		expect(store.getSummary("task-1")?.completedResponses.map((entry) => entry.text)).toEqual([
			olderReply,
			latestReply,
		]);
		await api.ingest(original);
		expect(store.getSummary("task-1")?.completedResponses).toHaveLength(2);
	});

	it("retains the Pi foreground reply while background work defers Review, without duplicating it at settle", async () => {
		const { api, manager, store, request } = createHarness("pi");
		const original = request(
			{ hookEventName: "AgentSettledBackgroundPending", finalMessage: latestReply },
			"activity",
		);
		await expect(api.ingest(replayRequest(original))).resolves.toEqual({ ok: true });
		expect(store.getSummary("task-1")?.state).toBe("running");
		expect(store.getSummary("task-1")?.completedResponses.map((entry) => entry.text)).toEqual([
			olderReply,
			latestReply,
		]);
		await api.ingest(original);
		expect(manager.evaluateHookEventOrder).toHaveLastReturnedWith({ accepted: false, reason: "duplicate_delivery" });
		await api.ingest(replayRequest(request({ finalMessage: latestReply }, "to_review", 300)));
		expect(store.getSummary("task-1")?.state).toBe("awaiting_review");
		expect(store.getSummary("task-1")?.completedResponses.map((entry) => entry.text)).toEqual([
			olderReply,
			latestReply,
		]);
	});

	for (const provider of providers) {
		it.each(["stale launch", "foreign provider", "subagent"] as const)(
			`does not replace the ${provider} foreground reply with a %s completion`,
			async (isolation) => {
				const { api, store, request } = createHarness(provider);
				const metadata: RuntimeHookMetadata = { finalMessage: "An unrelated answer must not become the preview." };
				if (isolation === "stale launch") metadata.sessionInstanceId = "retired-launch";
				if (isolation === "foreign provider") metadata.source = provider === "codex" ? "claude" : "codex";
				if (isolation === "subagent") metadata.providerAgentId = "child-agent";
				const original = request(metadata);
				await expect(api.ingest(replayRequest(original))).resolves.toEqual({ ok: true });
				await expect(api.ingest(original)).resolves.toEqual({ ok: true });
				expect(store.getSummary("task-1")?.completedResponses.map((entry) => entry.text)).toEqual([olderReply]);
			},
		);

		it.each([undefined, null, "", " \n "])(
			`does not invent a ${provider} reply when native completion text is %s`,
			async (text) => {
				const { api, store, request } = createHarness(provider);
				const original = request({ finalMessage: text, conversationSummaryText: text });
				await expect(api.ingest(replayRequest(original))).resolves.toEqual({ ok: true });
				await api.ingest(original);
				expect(store.getSummary("task-1")?.completedResponses.map((entry) => entry.text)).toEqual([olderReply]);
			},
		);
	}

	it.each(providers)("retains the bounded %s reply without letting the full duplicate extend it", async (provider) => {
		const { api, store, request } = createHarness(provider);
		const fullReply = `${latestReply}\n${"More shortcut details. ".repeat(40)}`;
		const expected = `${fullReply.slice(0, 500)}\u2026`;
		const original = request({ finalMessage: fullReply });
		await expect(api.ingest(replayRequest(original))).resolves.toEqual({ ok: true });
		expect(store.getSummary("task-1")?.completedResponses.at(-1)?.text).toBe(expected);
		await api.ingest(original);
		expect(store.getSummary("task-1")?.completedResponses.map((entry) => entry.text)).toEqual([olderReply, expected]);
	});

	it("keeps the newest replayed answer within the existing count and text retention limits", async () => {
		const { api, store, request } = createHarness("codex");
		for (let index = 0; index < 6; index += 1) {
			store.appendCompletedResponse("task-1", {
				text: `Earlier ${index}: ${"x".repeat(280)}`,
				capturedAt: index + 2,
			});
		}
		const original = request({ finalMessage: latestReply });
		await api.ingest(replayRequest(original));
		const entries = store.getSummary("task-1")?.completedResponses ?? [];
		expect(entries).toHaveLength(5);
		expect(entries[0]?.text).toBe(olderReply);
		expect(entries.at(-1)?.text).toBe(latestReply);
		expect(entries.reduce((total, entry) => total + entry.text.length, 0)).toBeLessThanOrEqual(2000);
		await api.ingest(original);
		expect(store.getSummary("task-1")?.completedResponses).toEqual(entries);
	});
});
