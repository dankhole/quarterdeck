import { afterEach, describe, expect, it, vi } from "vitest";

import { buildHookIngestRequest } from "../../../../src/commands/hook-metadata";
import type { RuntimeHookIngestRequest, RuntimeHookMetadata } from "../../../../src/core";
import type { RuntimeDiagnostics } from "../../../../src/diagnostics";
import { InMemorySessionSummaryStore } from "../../../../src/terminal";
import { createMockManager, createSummary, createTestApi } from "./_helpers";

function createHarness(agentId: "codex" | "claude" | "pi" = "claude") {
	const store = new InMemorySessionSummaryStore();
	store.ensureEntry("task-1");
	store.update("task-1", createSummary({ agentId, sessionInstanceId: "launch-1" }));
	const manager = createMockManager({
		getSummary: store.getSummary.bind(store),
		onChange: store.onChange.bind(store),
		appendCompletedResponse: store.appendCompletedResponse.bind(store),
	});
	manager.applyProviderHook = vi.fn((taskId, input) =>
		store.applySessionEvent(taskId, {
			type: "provider.hook",
			event: input.event,
			metadata: input.metadata,
			sessionEvidence: "live",
		}),
	);
	const recordEvent = vi.fn<RuntimeDiagnostics["recordEvent"]>();
	const persistSessionState = vi.fn(async (): Promise<void> => undefined);
	const api = createTestApi(manager, {
		diagnostics: { recordEvent } as unknown as RuntimeDiagnostics,
		persistSessionState,
	});
	const completion = (metadata: RuntimeHookMetadata = {}): RuntimeHookIngestRequest => ({
		taskId: "task-1",
		projectId: "project-1",
		event: "to_review",
		metadata: {
			source: agentId,
			sessionInstanceId: "launch-1",
			hookEventName: agentId === "pi" ? "AgentSettled" : "Stop",
			...metadata,
		},
	});
	const outcomes = () =>
		recordEvent.mock.calls.filter(([name]) => name === "hook.completion_capture").map(([, payload]) => payload);
	return { api, manager, store, recordEvent, persistSessionState, completion, outcomes };
}

afterEach(() => vi.restoreAllMocks());

describe("createHooksApi — content-free completion diagnostics", () => {
	it.each(["codex", "claude", "pi"] as const)(
		"reports a retained %s foreground reply without its content",
		async (agentId) => {
			const { api, completion, recordEvent, outcomes, store } = createHarness(agentId);
			const request = completion({
				finalMessage: "sentinel-private-final-reply",
				conversationSummaryText: "sentinel-private-legacy-reply",
				activityText: "sentinel-private-activity",
				toolInputSummary: "sentinel-private-tool-input",
				transcriptPath: "/tmp/sentinel-private-transcript.jsonl",
				promptId: "sentinel-private-prompt",
			});
			await expect(api.ingest(request)).resolves.toEqual({ ok: true });

			expect(store.getSummary("task-1")?.completedResponses.at(-1)?.text).toBe("sentinel-private-final-reply");
			expect(outcomes()).toEqual([{ outcome: "retained" }]);
			expect(recordEvent).toHaveBeenCalledWith(
				"hook.received",
				{
					event: "to_review",
					source: agentId,
					hookEventName: agentId === "pi" ? "AgentSettled" : "Stop",
					notificationType: null,
					hasTurnId: false,
					hasPromptId: true,
					hasToolUseId: false,
					hasSessionId: false,
					hasFinalMessage: true,
					hasConversationSummaryText: true,
				},
				{ projectId: "project-1", taskId: "task-1", sessionInstanceId: "launch-1" },
				{ essential: true },
			);
			expect(recordEvent).toHaveBeenCalledWith(
				"hook.completion_capture",
				{ outcome: "retained" },
				{ projectId: "project-1", taskId: "task-1", sessionInstanceId: "launch-1" },
				{ essential: true },
			);
			expect(JSON.stringify(recordEvent.mock.calls)).not.toContain("sentinel-private");
		},
	);

	it("reports legacy fallback retention and missing capture without replacing historical replies", async () => {
		const { api, completion, recordEvent, outcomes, store } = createHarness();
		await api.ingest(completion({ finalMessage: " \n", conversationSummaryText: "sentinel-private-fallback" }));
		await api.ingest(completion({ finalMessage: "\t", conversationSummaryText: " \n" }));
		await api.ingest(completion());

		expect(outcomes()).toEqual([{ outcome: "retained" }, { outcome: "missing" }, { outcome: "missing" }]);
		expect(store.getSummary("task-1")?.completedResponses.map(({ text }) => text)).toEqual([
			"sentinel-private-fallback",
		]);
		const received = recordEvent.mock.calls.filter(([name]) => name === "hook.received");
		expect(received.map(([, payload]) => payload)).toEqual([
			expect.objectContaining({ hasFinalMessage: false, hasConversationSummaryText: true }),
			expect.objectContaining({ hasFinalMessage: false, hasConversationSummaryText: false }),
			expect.objectContaining({ hasFinalMessage: false, hasConversationSummaryText: false }),
		]);
		expect(JSON.stringify(recordEvent.mock.calls)).not.toContain("sentinel-private");
	});

	it("uses the store's canonical deduplication after text truncation and retention eviction", async () => {
		const { api, completion, outcomes, store } = createHarness();
		for (let index = 0; index < 7; index++) {
			store.appendCompletedResponse("task-1", { text: `Historical reply ${index}`, capturedAt: index });
		}
		const prefix = "r".repeat(500);
		await api.ingest(completion({ finalMessage: `${prefix}first tail` }));
		await api.ingest(completion({ finalMessage: `${prefix}different tail` }));

		expect(outcomes()).toEqual([{ outcome: "retained" }, { outcome: "deduplicated" }]);
		expect(store.getSummary("task-1")?.completedResponses.at(-1)?.text).toBe(`${prefix}\u2026`);
	});

	it("does not report missing capture for a Claude Stop still waiting on background work", async () => {
		const { api, store, outcomes, completion } = createHarness("claude");
		await api.ingest({ ...completion({ hookEventName: "UserPromptSubmit" }), event: "to_in_progress" });
		expect(store.getSummary("task-1")?.state).toBe("running");
		const buildStop = (pending: boolean) =>
			buildHookIngestRequest({
				event: "to_review",
				identity: { projectId: "project-1", taskId: "task-1", sessionInstanceId: "launch-1" },
				flagMetadata: { source: "claude" },
				payload: {
					hook_event_name: "Stop",
					last_assistant_message: "sentinel-private-claude-reply",
					background_tasks: pending ? [{ id: "worker-1", type: "subagent" }] : [],
				},
			});
		const pending = buildStop(true);
		expect(pending.event).toBe("activity");
		expect(pending.metadata?.finalMessage).toBeNull();
		await expect(api.ingest(pending)).resolves.toEqual({ ok: true });
		expect(store.getSummary("task-1")?.state).toBe("running");
		expect(store.getSummary("task-1")?.completedResponses).toEqual([]);
		expect(outcomes()).toEqual([]);

		await expect(api.ingest(buildStop(false))).resolves.toEqual({ ok: true });
		expect(store.getSummary("task-1")?.state).toBe("awaiting_review");
		expect(store.getSummary("task-1")?.completedResponses.at(-1)?.text).toBe("sentinel-private-claude-reply");
		expect(outcomes()).toEqual([{ outcome: "retained" }]);
	});

	it("reports Pi's pending-background reply then its deduplicated settled completion", async () => {
		const { api, completion, outcomes, store } = createHarness("pi");
		await api.ingest({ ...completion({ hookEventName: "AgentStart" }), event: "to_in_progress" });
		await api.ingest({
			...completion({ hookEventName: "AgentSettledBackgroundPending", finalMessage: "sentinel-private-pi-reply" }),
			event: "activity",
		});
		expect(store.getSummary("task-1")?.state).toBe("running");
		await api.ingest(completion({ finalMessage: "sentinel-private-pi-reply" }));
		expect(outcomes()).toEqual([{ outcome: "retained" }, { outcome: "deduplicated" }]);
		expect(store.getSummary("task-1")?.state).toBe("awaiting_review");
	});

	it.each(["duplicate_delivery", "stale_session", "stale_prompt", "non_foreground_session"] as const)(
		"does not report an accepted capture for ordering rejection %s",
		async (reason) => {
			const { api, manager, completion, outcomes } = createHarness();
			vi.spyOn(manager, "evaluateHookEventOrder").mockReturnValue({ accepted: false, reason });
			await expect(api.ingest(completion({ finalMessage: "sentinel-private-rejected" }))).resolves.toEqual({
				ok: true,
			});
			expect(outcomes()).toEqual([]);
			expect(manager.applyProviderHook).not.toHaveBeenCalled();
		},
	);

	it("does not report captures for foreign providers, subagents, or non-completion hooks", async () => {
		const { api, completion, outcomes, store } = createHarness();
		for (const metadata of [
			{ source: "codex" },
			{ providerAgentId: "child-agent" },
			{ hookEventName: "SubagentStop" },
			{ hookEventName: "PostCompact" },
		]) {
			await api.ingest(completion({ ...metadata, finalMessage: "sentinel-private-not-foreground" }));
		}
		expect(outcomes()).toEqual([]);
		expect(store.getSummary("task-1")?.completedResponses).toEqual([]);
	});

	it.each(["preserve", "identity_only"] as const)(
		"respects the reducer's %s metadata guard",
		async (hookMetadataMode) => {
			const { api, manager, completion, outcomes, store } = createHarness();
			const summary = store.getSummary("task-1");
			if (!summary) throw new Error("Missing fixture session");
			vi.spyOn(manager, "applyProviderHook").mockReturnValue({
				changed: false,
				patch: {},
				clearAttentionBuffer: false,
				hookMetadataMode,
				summary,
			});
			await api.ingest(completion({ finalMessage: "sentinel-private-guarded" }));
			expect(outcomes()).toEqual([]);
			expect(store.getSummary("task-1")?.completedResponses).toEqual([]);
		},
	);

	it("reports accepted retention only after the durability barrier resolves", async () => {
		const { api, completion, outcomes, persistSessionState } = createHarness();
		let finishWrite!: () => void;
		persistSessionState.mockReturnValue(
			new Promise<void>((resolve) => {
				finishWrite = resolve;
			}),
		);
		const ingest = api.ingest(completion({ finalMessage: "sentinel-private-durable" }));
		await vi.waitFor(() => expect(persistSessionState).toHaveBeenCalledOnce());
		expect(outcomes()).toEqual([]);
		finishWrite();
		await expect(ingest).resolves.toEqual({ ok: true });
		expect(outcomes()).toEqual([{ outcome: "retained" }]);
	});

	it("keeps arbitrary persistence errors out of diagnostics and does not claim accepted retention", async () => {
		vi.spyOn(console, "error").mockImplementation(() => undefined);
		const { api, completion, outcomes, persistSessionState, recordEvent } = createHarness();
		persistSessionState.mockRejectedValue(new Error("sentinel-private-error /tmp/sentinel-private-path"));
		await expect(api.ingest(completion({ finalMessage: "sentinel-private-reply" }))).resolves.toEqual({
			ok: false,
			error: "sentinel-private-error /tmp/sentinel-private-path",
		});
		expect(outcomes()).toEqual([]);
		expect(recordEvent).toHaveBeenCalledWith("hook.ingest_failed", { errorClass: "Error" }, expect.any(Object), {
			level: "error",
			essential: true,
		});
		expect(JSON.stringify(recordEvent.mock.calls)).not.toContain("sentinel-private");
	});
});
