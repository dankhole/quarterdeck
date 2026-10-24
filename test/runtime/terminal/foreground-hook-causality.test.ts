import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildHookIngestRequest } from "../../../src/commands/hook-metadata";
import {
	type RuntimeHookEvent,
	type RuntimeHookIngestRequest,
	runtimeTaskSessionSummarySchema,
} from "../../../src/core";
import { createHookDeliveryIdGenerator } from "../../../src/hook-delivery-order";
import {
	commitHookEventOrder,
	compactProviderHookOrderObservations,
	correlateClaudePermissionToolUseId,
	correlateCodexPermissionToolUseId,
	createHookEventOrderState,
	createProviderHookOrderObservation,
	evaluateHookEventOrder,
	recordHookUserSubmission,
	restoreHookEventOrderState,
} from "../../../src/terminal/hook-event-order";
import type { PtySession } from "../../../src/terminal/pty-session";
import { scheduleInterruptRecovery } from "../../../src/terminal/session-interrupt-recovery";
import { createActiveProcessState, createProcessEntry } from "../../../src/terminal/session-manager-types";
import {
	hasMeaningfulSessionSummaryChange,
	InMemorySessionSummaryStore,
} from "../../../src/terminal/session-summary-store";
import { SessionTransitionController } from "../../../src/terminal/session-transition-controller";

type Provider = "claude" | "codex" | "pi";

function harness(provider: Provider, withScope = true) {
	const store = new InMemorySessionSummaryStore();
	store.ensureEntry("task");
	store.update("task", {
		agentId: provider,
		sessionInstanceId: "launch",
		resumeSessionId: "session",
		pid: 1234,
		state: "awaiting_review",
		reviewReason: "unconfirmed",
	});
	const entry = createProcessEntry("task");
	entry.active = createActiveProcessState({
		session: { pid: 1234, wasInterrupted: vi.fn(() => false) } as unknown as PtySession,
		sessionInstanceId: "launch",
		agentId: provider,
		cols: 120,
		rows: 40,
		willAutoTrust: false,
	});
	entry.hookEventOrder = createHookEventOrderState("launch");
	const controller = new SessionTransitionController(store, new Map([["task", entry]]));
	const start = provider === "pi" ? "AgentStart" : "UserPromptSubmit";
	const stop = provider === "pi" ? "AgentSettled" : "Stop";
	function request(
		name: string,
		time: number,
		options: {
			scope?: string | null;
			tool?: string;
			toolName?: string;
			agent?: string;
			background?: boolean;
			finalMessage?: string;
		} = {},
	): RuntimeHookIngestRequest {
		vi.setSystemTime(time);
		const scope = options.scope === undefined ? (withScope ? "old" : null) : options.scope;
		const event: RuntimeHookEvent =
			name === stop || name === "Interrupt" || name === "PermissionRequest"
				? "to_review"
				: name === "PreToolUse" ||
						name === "ToolExecutionStart" ||
						name === "ToolExecutionEnd" ||
						name === "AgentEnd" ||
						name === "AgentSettledBackgroundPending"
					? "activity"
					: "to_in_progress";
		return buildHookIngestRequest({
			event,
			identity: { taskId: "task", projectId: "project", sessionInstanceId: "launch" },
			flagMetadata: { source: provider, finalMessage: options.finalMessage },
			payload: {
				hook_event_name: name,
				session_id: "session",
				...(scope ? (provider === "claude" ? { prompt_id: scope } : { turn_id: scope }) : {}),
				...(options.tool ? { tool_use_id: options.tool } : {}),
				...(options.toolName || options.tool ? { tool_name: options.toolName ?? "Bash" } : {}),
				...(options.agent ? { agent_id: options.agent } : {}),
				...(options.background ? { background_tasks: [{ type: "shell" }] } : {}),
			},
		});
	}
	function ingest(input: RuntimeHookIngestRequest) {
		const order = evaluateHookEventOrder(entry.hookEventOrder, input);
		if (!order.accepted) return { order, result: null };
		const result = controller.applyTransitionEvent(entry, {
			type: "provider.hook",
			event: input.event,
			metadata: input.metadata,
			occurredAt: input.delivery?.occurredAt,
			deliveryId: input.delivery?.id,
			correlatedToolUseId:
				correlateClaudePermissionToolUseId(entry.hookEventOrder, input) ??
				correlateCodexPermissionToolUseId(entry.hookEventOrder, input),
		});
		const advanceTurn = result?.hookMetadataMode === "apply" || result?.hookOrderingMode === "advance";
		commitHookEventOrder(entry.hookEventOrder, input, { advanceTurn });
		if (advanceTurn) store.recordProviderHookReceipt("task", createProviderHookOrderObservation(input));
		return { order, result };
	}
	function interrupt() {
		vi.setSystemTime(250);
		entry.suppressAutoRestartOnExit = true;
		scheduleInterruptRecovery(entry, "ctrl_c", {
			getEntry: () => entry,
			getSummary: () => store.getSummary("task"),
			applyTransitionEvent: (current, event) => controller.applyTransitionEvent(current, event),
		});
		expect(store.getSummary("task")).toMatchObject({ state: "awaiting_review", reviewReason: "interrupted" });
	}
	const initial = request(start, 100);
	ingest(initial);
	const predecessor = request(provider === "pi" ? "ToolExecutionStart" : "PreToolUse", 150, { tool: "old-tool" });
	ingest(predecessor);
	return { store, entry, controller, request, ingest, interrupt, start, stop, initial, predecessor };
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe("foreground causal boundaries (normalized probe regressions)", () => {
	it.each([
		["claude", true, "PostToolUse"],
		["claude", true, "PostToolUseFailure"],
		["claude", false, "PostToolUse"],
		["claude", false, "PostToolUseFailure"],
		["codex", true, "PostToolUse"],
		["pi", true, "AgentStart"],
		["pi", true, "ToolExecutionEnd"],
	] as const)("fences known %s work (%s scope, %s) regardless of subprocess stamp", (provider, scope, name) => {
		for (const stamp of [200, 300]) {
			const h = harness(provider, scope);
			const delayed = h.request(name, stamp, { tool: name === "AgentStart" ? undefined : "old-tool" });
			h.interrupt();
			vi.advanceTimersByTime(5_001);
			expect(h.ingest(delayed).order.accepted).toBe(false);
			expect(h.store.getSummary("task")).toMatchObject({
				state: "awaiting_review",
				reviewReason: "interrupted",
				nativeWorkEvidence: null,
			});
			// The provider, not local intent, still owns terminal settlement.
			const settlement = h.request(provider === "claude" ? h.stop : "Interrupt", 6_000);
			expect(h.ingest(settlement).order.accepted).toBe(true);
			expect(h.store.getSummary("task")?.reviewReason).toBe(provider === "claude" ? "hook" : "interrupted");
			expect(h.ingest(settlement).order).toEqual({ accepted: false, reason: "duplicate_delivery" });
			expect(h.ingest(h.request(h.start, 6_100, { scope: scope ? "next" : null })).order.accepted).toBe(true);
			expect(h.store.getSummary("task")?.state).toBe("running");
		}
	});

	it.each(["claude", "codex", "pi"] as const)(
		"does not let direct %s controller calls bypass the local identity fence",
		(provider) => {
			const h = harness(provider);
			h.interrupt();
			const delayed = h.request(h.start, 300);
			const result = h.controller.applyTransitionEvent(h.entry, {
				type: "provider.hook",
				event: delayed.event,
				metadata: delayed.metadata,
				occurredAt: delayed.delivery?.occurredAt,
			});
			expect(result?.changed).toBe(false);
			expect(result?.summary.reviewReason).toBe("interrupted");
		},
	);

	it.each(["claude", "codex", "pi"] as const)(
		"keeps newer %s foreground evidence and rejects old work after it",
		(provider) => {
			const h = harness(provider);
			h.interrupt();
			expect(h.ingest(h.request(h.start, 300, { scope: "next" })).order.accepted).toBe(true);
			expect(h.store.getSummary("task")?.state).toBe("running");
			expect(h.ingest(h.request(h.start, 400)).order.accepted).toBe(false);
			expect(h.store.getSummary("task")?.nativeWorkEvidence).toMatchObject({
				...(provider === "claude" ? { promptId: "next" } : { turnId: "next" }),
			});
		},
	);

	it.each([true, false])(
		"rejects prompt-less Claude completion after Stop (initial prompt identity: %s), including compacted replay",
		(scope) => {
			for (const stamp of [200, 300]) {
				const h = harness("claude", scope);
				const stop = h.request(h.stop, 250, { finalMessage: "Retained final reply" });
				h.ingest(stop);
				const delayed = h.request("PostToolUse", stamp, { scope: null, tool: "old-tool" });
				expect(h.ingest(delayed).order.accepted).toBe(false);
				expect(h.store.getSummary("task")?.state).toBe("awaiting_review");
				const observations = [h.initial, h.predecessor, stop].flatMap((input) => {
					const observation = createProviderHookOrderObservation(input);
					return observation ? [observation] : [];
				});
				h.entry.hookEventOrder = restoreHookEventOrderState({
					sessionInstanceId: "launch",
					observations: compactProviderHookOrderObservations(observations, 512),
					recentDeliveryIds: [],
					outstandingInteraction: null,
				});
				expect(h.ingest(delayed).order.accepted).toBe(false);
				// A new native tool start is sufficient even if its prompt hook is missing.
				h.ingest(h.request("PreToolUse", 400, { scope: null, tool: "new-tool" }));
				expect(h.store.getSummary("task")?.state).toBe("running");
				expect(h.ingest(h.request("PostToolUse", 450, { scope: null, tool: "old-tool" })).order.accepted).toBe(
					false,
				);
				expect(h.ingest(h.request("PostToolUse", 460, { scope: null, tool: "new-tool" })).order.accepted).toBe(
					true,
				);
			}
		},
	);

	it.each(["Stop", "Interrupt"])(
		"fails closed for a late Codex completion omitting turn identity after %s",
		(boundary) => {
			const h = harness("codex");
			h.ingest(h.request(boundary, 250));
			expect(h.ingest(h.request("PostToolUse", 300, { scope: null, tool: "old-tool" })).order.accepted).toBe(false);
			expect(h.store.getSummary("task")?.state).toBe("awaiting_review");
		},
	);

	it.each([true, false])(
		"preserves Claude unbounded-background wake after Stop and local Ctrl-C (prompt identity: %s)",
		(scope) => {
			const h = harness("claude", scope);
			const stop = h.request(h.stop, 200, { background: true });
			expect(stop.metadata?.unboundedBackgroundWorkPending).toBe(true);
			h.ingest(stop);
			h.ingest(h.request("PreToolUse", 230, { tool: "first-wake-tool" }));
			h.interrupt();
			expect(h.ingest(h.request("PostToolUse", 300, { tool: "old-tool" })).order.accepted).toBe(false);
			expect(h.ingest(h.request("PreToolUse", 350, { tool: "wake-tool" })).order.accepted).toBe(true);
			expect(h.store.getSummary("task")?.state).toBe("running");
			expect(h.ingest(h.request("PostToolUse", 400, { tool: "wake-tool" })).order.accepted).toBe(true);
		},
	);

	it.each([true, false])("keeps unrelated Claude permission response pending (prompt identity: %s)", (scope) => {
		const h = harness("claude", scope);
		h.ingest(h.request("PreToolUse", 200, { tool: "permission-tool", toolName: "Write" }));
		h.ingest(h.request("PermissionRequest", 220, { toolName: "Write" }));
		const interaction = h.store.getSummary("task")?.outstandingInteraction ?? null;
		expect(interaction?.toolUseId).toBe("permission-tool");
		recordHookUserSubmission(h.entry.hookEventOrder, 250, interaction);
		h.controller.applyTransitionEvent(h.entry, {
			type: "interaction.response_submitted",
			occurredAt: 250,
			responseKind: "submit",
		});
		h.ingest(h.request("PostToolUse", 350, { tool: "old-tool" }));
		expect(h.store.getSummary("task")).toMatchObject({
			state: "awaiting_review",
			outstandingInteraction: { status: "response_submitted", toolUseId: "permission-tool" },
		});
	});

	it.each([240, 300])("does not fence Codex child resolution captured at %s across root Ctrl-C", (completionTime) => {
		const h = harness("codex");
		h.ingest(h.request("PreToolUse", 200, { scope: "child-turn", agent: "child", tool: "child-tool" }));
		h.ingest(h.request("PermissionRequest", 220, { scope: "child-turn", agent: "child", tool: "child-tool" }));
		const completion = h.request("PostToolUse", completionTime, {
			scope: "child-turn",
			agent: "child",
			tool: "child-tool",
		});
		h.interrupt();
		const recoveryTimer = h.entry.active?.interruptRecoveryTimer;
		expect(h.store.getSummary("task")?.subagentInteractions?.[0]?.status).toBe("waiting");
		expect(h.ingest(completion).order.accepted).toBe(true);
		expect(h.entry.active?.lastInterruptAt).toBe(250);
		expect(h.entry.active?.interruptRecoveryTimer).toBe(recoveryTimer);
		expect(h.entry.suppressAutoRestartOnExit).toBe(true);
		expect(h.store.getSummary("task")?.subagentInteractions).toEqual([]);
		expect(h.store.getSummary("task")?.reviewReason).toBe("interrupted");
	});

	it.each([false, true])(
		"severs named Claude ownership at an anonymous prompt (background: %s), including replay",
		(background) => {
			const h = harness("claude");
			const inputs = [h.initial, h.predecessor];
			if (background) {
				const stop = h.request(h.stop, 200, { background: true });
				h.ingest(stop);
				inputs.push(stop);
			}
			const anonymousStart = h.request(h.start, 300, { scope: null });
			h.ingest(anonymousStart);
			inputs.push(anonymousStart);
			expect(h.entry.hookEventOrder?.activeClaudePromptId).toBeNull();
			expect(h.entry.hookEventOrder?.claudeForegroundPromptActive).toBe(true);
			const anonymousStop = h.request(h.stop, 400, { scope: null });
			h.ingest(anonymousStop);
			inputs.push(anonymousStop);
			const observations = inputs.flatMap((input) => {
				const observation = createProviderHookOrderObservation(input);
				return observation ? [observation] : [];
			});
			for (const state of [
				h.entry.hookEventOrder,
				restoreHookEventOrderState({
					sessionInstanceId: "launch",
					observations: compactProviderHookOrderObservations(observations, 512),
					recentDeliveryIds: [],
					outstandingInteraction: null,
				}),
			]) {
				expect(state?.activeClaudePromptId).toBeNull();
				expect(state?.claudeForegroundPromptActive).toBe(false);
				expect(state?.retiredClaudePromptIds.has("old")).toBe(!background);
				expect(evaluateHookEventOrder(state, h.request("PreToolUse", 500, { tool: "wake" })).accepted).toBe(
					background,
				);
				expect(evaluateHookEventOrder(state, h.request("PostToolUse", 500, { tool: "old-tool" })).accepted).toBe(
					background,
				);
			}
		},
	);

	it.each([false, true])(
		"prevents an older Claude background wake from taking a newer foreground wait (anonymous: %s)",
		(anonymous) => {
			const h = harness("claude");
			const inputs = [h.initial, h.predecessor];
			for (const input of [
				h.request(h.stop, 200, { background: true }),
				h.request(h.start, 300, { scope: anonymous ? null : "next" }),
				h.request("PreToolUse", 350, { scope: anonymous ? null : "next", tool: "new-tool" }),
				h.request("PermissionRequest", 360, { scope: anonymous ? null : "next", tool: "new-tool" }),
			]) {
				h.ingest(input);
				inputs.push(input);
			}
			const wait = h.store.getSummary("task")?.outstandingInteraction;
			const observations = inputs.flatMap((input) => {
				const observation = createProviderHookOrderObservation(input);
				return observation ? [observation] : [];
			});
			for (const state of [
				h.entry.hookEventOrder,
				restoreHookEventOrderState({
					sessionInstanceId: "launch",
					observations: compactProviderHookOrderObservations(observations, 512),
					recentDeliveryIds: [],
					outstandingInteraction: wait ?? null,
				}),
			]) {
				h.entry.hookEventOrder = state;
				for (const name of ["UserPromptSubmit", "PreToolUse", "PostToolUse", "Stop"]) {
					expect(h.ingest(h.request(name, 500, { tool: "old-wake" })).order).toEqual({
						accepted: false,
						reason: "stale_prompt",
					});
					expect(h.store.getSummary("task")?.outstandingInteraction).toEqual(wait);
				}
			}
		},
	);

	it.each(["AgentSettled", "AgentEnd", "AgentSettledBackgroundPending"])(
		"admits an equal-time Pi AgentStart only after a causally ordered %s",
		(boundaryName) => {
			const h = harness("pi");
			const nextId = createHookDeliveryIdGenerator();
			const olderId = nextId();
			const boundary = h.request(boundaryName, 200);
			boundary.delivery = { id: nextId(), occurredAt: 200 };
			h.ingest(boundary);
			const next = h.request("AgentStart", 200, { scope: "next" });
			next.delivery = { id: nextId(), occurredAt: 200 };
			const observations = [h.initial, boundary].flatMap((input) => {
				const observation = createProviderHookOrderObservation(input);
				return observation ? [observation] : [];
			});
			for (const state of [
				h.entry.hookEventOrder,
				restoreHookEventOrderState({
					sessionInstanceId: "launch",
					observations: compactProviderHookOrderObservations(observations, 512),
					recentDeliveryIds: [],
					outstandingInteraction: null,
				}),
			]) {
				for (const id of [olderId, boundary.delivery.id, createHookDeliveryIdGenerator()()]) {
					expect(evaluateHookEventOrder(state, { ...next, delivery: { id, occurredAt: 200 } })).toEqual({
						accepted: false,
						reason: id === boundary.delivery.id ? "duplicate_delivery" : "stale_turn",
					});
				}
				expect(
					evaluateHookEventOrder(state, { ...next, delivery: { id: next.delivery.id, occurredAt: 199 } }),
				).toEqual({ accepted: false, reason: "stale_turn" });
				expect(
					evaluateHookEventOrder(state, {
						...next,
						event: "activity",
						metadata: { ...next.metadata, hookEventName: "ToolExecutionStart" },
					}),
				).toEqual({ accepted: false, reason: "stale_turn" });
				expect(evaluateHookEventOrder(state, next)).toEqual({ accepted: true });
			}
			h.ingest(next);
			expect(h.store.getSummary("task")?.state).toBe("running");
			expect(h.ingest(h.request("AgentStart", 300)).order.accepted).toBe(false);
		},
	);

	it("does not infer Pi run succession from an ordered tool or unsettled start alone", () => {
		for (const name of ["AgentStart", "ToolExecutionStart"]) {
			const h = harness("pi");
			const nextId = createHookDeliveryIdGenerator();
			const current = h.request(name, 200, { tool: name === "ToolExecutionStart" ? "tool" : undefined });
			current.delivery = { id: nextId(), occurredAt: 200 };
			h.ingest(current);
			const next = h.request("AgentStart", 200, { scope: "next" });
			next.delivery = { id: nextId(), occurredAt: 200 };
			expect(h.ingest(next).order).toEqual({ accepted: false, reason: "stale_turn" });
		}
	});

	it("does not let a retired recovery timer clear replacement bookkeeping", () => {
		const h = harness("codex");
		h.interrupt();
		vi.advanceTimersByTime(750);
		h.entry.active = createActiveProcessState({
			session: { pid: 1235, wasInterrupted: () => false } as unknown as PtySession,
			sessionInstanceId: "replacement",
			agentId: "codex",
			cols: 120,
			rows: 40,
			willAutoTrust: false,
		});
		scheduleInterruptRecovery(h.entry, "ctrl_c", {
			getEntry: () => h.entry,
			getSummary: () => h.store.getSummary("task"),
			applyTransitionEvent: () => null,
		});
		const timer = h.entry.active.interruptRecoveryTimer;
		vi.advanceTimersByTime(4_300);
		expect(h.entry.active.interruptRecoveryTimer).toBe(timer);
		expect(h.entry.active.interruptRecoveryStartedAt).toBe(1_000);
	});

	it.each(["resume", "clear"] as const)(
		"admits verified Codex %s navigation after Ctrl-C without admitting a side thread",
		(sessionStartSource) => {
			const h = harness("codex");
			h.interrupt();
			const navigate = h.request("SessionStart", 300);
			navigate.event = "activity";
			navigate.metadata = { ...navigate.metadata, sessionId: "session-b", turnId: null, sessionStartSource };
			expect(
				h.ingest({ ...navigate, delivery: { id: "00000000-0000-4000-8000-000000000901", occurredAt: 200 } }).order
					.accepted,
			).toBe(false);
			expect(
				h.ingest({ ...navigate, metadata: { ...navigate.metadata, sessionStartSource: "fork" } }).order.accepted,
			).toBe(false);
			expect(h.ingest({ ...navigate, metadata: { ...navigate.metadata, providerAgentId: "child" } }).order).toEqual({
				accepted: false,
				reason: "non_foreground_session",
			});
			expect(h.ingest(navigate).order.accepted).toBe(true);
			expect(h.store.getSummary("task")).toMatchObject({
				state: "awaiting_review",
				reviewReason: "unconfirmed",
				resumeSessionId: "session-b",
				localForegroundInterrupt: null,
			});
			expect(h.entry.hookEventOrder?.foregroundInterrupt).toBeNull();
			const next = h.request(h.start, 400, { scope: "next" });
			next.metadata = { ...next.metadata, sessionId: "session-b" };
			expect(h.ingest(next).order.accepted).toBe(true);
			expect(h.store.getSummary("task")?.state).toBe("running");
			expect(h.ingest(h.request(h.start, 500)).order).toEqual({ accepted: false, reason: "non_foreground_session" });
		},
	);

	it("settles a named Claude background wake whose tool start omitted prompt identity, including replay", () => {
		const h = harness("claude");
		h.ingest(h.request(h.stop, 200, { background: true }));
		h.ingest(h.request("PreToolUse", 300, { scope: null, tool: "wake-tool" }));
		expect(h.store.getSummary("task")?.state).toBe("running");
		const summary = h.store.getSummary("task");
		if (!summary) throw new Error("Missing summary");
		for (const state of [
			h.entry.hookEventOrder,
			restoreHookEventOrderState({
				sessionInstanceId: "launch",
				observations: summary.recentProviderHookOrderObservations,
				recentDeliveryIds: [],
				outstandingInteraction: null,
			}),
		]) {
			h.entry.hookEventOrder = state;
			expect(h.ingest(h.request("PostToolUse", 400, { tool: "wake-tool" })).order.accepted).toBe(true);
			expect(h.ingest(h.request(h.stop, 500)).order.accepted).toBe(true);
			expect(h.store.getSummary("task")).toMatchObject({ state: "awaiting_review", reviewReason: "hook" });
		}
	});

	it.each(["claude", "codex", "pi"] as const)(
		"restores the known %s local negative fence without inventing a provider receipt",
		(provider) => {
			const h = harness(provider);
			h.interrupt();
			const summary = runtimeTaskSessionSummarySchema.parse(JSON.parse(JSON.stringify(h.store.getSummary("task"))));
			expect(summary.localForegroundInterrupt).toMatchObject({
				sessionInstanceId: "launch",
				provider,
				scopeId: "old",
				occurredAt: 250,
				awaitingNativeStart: true,
			});
			expect(summary.recentProviderHookOrderObservations).toHaveLength(2);
			const restored = restoreHookEventOrderState({
				sessionInstanceId: "launch",
				observations: summary.recentProviderHookOrderObservations,
				recentDeliveryIds: summary.recentProviderHookDeliveryIds,
				outstandingInteraction: summary.outstandingInteraction,
				localForegroundInterrupt: summary.localForegroundInterrupt,
			});
			for (const input of [
				h.request("PermissionRequest", 300),
				h.request(provider === "pi" ? "AgentStart" : "PostToolUse", 350, { tool: "old-tool" }),
				h.request(provider === "pi" ? "ToolExecutionEnd" : "PostToolUse", 375, { scope: null, tool: "old-tool" }),
				h.request(h.stop, 400),
				h.request(h.start, 450, { scope: "next" }),
			]) {
				expect(evaluateHookEventOrder(restored, input)).toEqual(
					evaluateHookEventOrder(h.entry.hookEventOrder, input),
				);
			}
			h.ingest(h.request(h.start, 500, { scope: "next" }));
			const running = runtimeTaskSessionSummarySchema.parse(JSON.parse(JSON.stringify(h.store.getSummary("task"))));
			expect(running).toMatchObject({
				state: "running",
				nativeWorkEvidence: { provider },
				localForegroundInterrupt: { awaitingNativeStart: false },
			});
			const afterNativeStart = restoreHookEventOrderState({
				sessionInstanceId: "launch",
				observations: running.recentProviderHookOrderObservations,
				recentDeliveryIds: running.recentProviderHookDeliveryIds,
				outstandingInteraction: null,
				localForegroundInterrupt: running.localForegroundInterrupt,
			});
			const anonymousWork = h.request("PreToolUse", 600, { scope: null, tool: "new-tool" });
			expect(evaluateHookEventOrder(afterNativeStart, anonymousWork)).toEqual(
				evaluateHookEventOrder(h.entry.hookEventOrder, anonymousWork),
			);
			const supersededCompletion = h.request(h.stop, 650);
			expect(evaluateHookEventOrder(afterNativeStart, supersededCompletion)).toEqual(
				evaluateHookEventOrder(h.entry.hookEventOrder, supersededCompletion),
			);
			expect(evaluateHookEventOrder(afterNativeStart, supersededCompletion).accepted).toBe(false);
		},
	);

	it("keeps legacy summaries optional and clears negative evidence on idle, agent change, or replacement", () => {
		const h = harness("claude");
		const legacy = runtimeTaskSessionSummarySchema.parse(JSON.parse(JSON.stringify(h.store.getSummary("task"))));
		expect(legacy.localForegroundInterrupt).toBeUndefined();
		h.interrupt();
		const summary = h.store.getSummary("task");
		if (!summary) throw new Error("Missing summary");
		const snapshot = h.store.getSummary("task");
		snapshot?.localForegroundInterrupt?.toolUseIds.push("not-authoritative");
		expect(h.store.getSummary("task")?.localForegroundInterrupt?.toolUseIds).not.toContain("not-authoritative");
		expect(hasMeaningfulSessionSummaryChange({ ...summary, localForegroundInterrupt: null }, summary)).toBe(true);
		for (const patch of [{ state: "idle" }, { agentId: "pi" }, { sessionInstanceId: "replacement" }] as const) {
			expect(runtimeTaskSessionSummarySchema.parse({ ...summary, ...patch }).localForegroundInterrupt).toBeNull();
		}
		expect(
			runtimeTaskSessionSummarySchema.safeParse({
				...summary,
				localForegroundInterrupt: {
					...summary.localForegroundInterrupt,
					toolUseIds: Array.from({ length: 513 }, () => "tool"),
				},
			}).success,
		).toBe(false);
	});

	it.each(["claude", "pi"] as const)(
		"characterizes unseen %s identity ambiguity without using input as Running evidence",
		(provider) => {
			const h = harness(provider);
			h.interrupt();
			// Frozen pre-interrupt capture times reject even a previously unseen identity.
			expect(h.ingest(h.request(h.start, 200, { scope: "unseen" })).order.accepted).toBe(false);
			// A first-seen identity stamped later is indistinguishable from a real
			// next turn. This is not a claim of provider-native occurrence ordering.
			expect(h.ingest(h.request(h.start, 300, { scope: "unseen" })).order.accepted).toBe(true);
			expect(h.store.getSummary("task")?.state).toBe("running");
		},
	);
});
