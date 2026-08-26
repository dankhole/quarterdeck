import { mkdir, mkdtemp, readdir, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { RuntimeHookIngestRequest } from "../../src/core";
import {
	createHookTransitionOutboxReplayer,
	createPersistedHookTransition,
	enqueueHookTransition,
	HOOK_TRANSITION_OUTBOX_TTL_MS,
	loadPendingHookTransitions,
} from "../../src/hook-transition-outbox";

const originalStateHome = process.env.QUARTERDECK_STATE_HOME;
let stateHome: string;

function request(index: number, occurredAt: number = index * 100): RuntimeHookIngestRequest {
	return {
		taskId: "task-1",
		projectId: "project-1",
		event: index % 2 === 0 ? "to_in_progress" : "to_review",
		metadata: {
			source: "codex",
			hookEventName: index % 2 === 0 ? "PostToolUse" : "PermissionRequest",
			sessionId: "resume-session",
			sessionInstanceId: "process-1",
			turnId: "turn-1",
			toolName: "Bash",
			toolUseId: index % 2 === 0 ? "tool-1" : null,
			activityText: "sensitive activity text",
			toolInputSummary: "sensitive command text",
			finalMessage: "sensitive final response",
			conversationSummaryText: "sensitive conversation summary",
			transcriptPath: "/private/transcript.jsonl",
		},
		delivery: {
			id: `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
			occurredAt,
		},
	};
}

beforeEach(async () => {
	stateHome = await mkdtemp(join(tmpdir(), "quarterdeck-hook-outbox-"));
	process.env.QUARTERDECK_STATE_HOME = stateHome;
});

afterEach(async () => {
	if (originalStateHome === undefined) {
		delete process.env.QUARTERDECK_STATE_HOME;
	} else {
		process.env.QUARTERDECK_STATE_HOME = originalStateHome;
	}
	await rm(stateHome, { recursive: true, force: true });
});

describe("hook transition outbox", () => {
	it("persists only the routing and ordering metadata needed for replay", () => {
		const record = createPersistedHookTransition(request(1), 1_000);

		expect(record).not.toBeNull();
		expect(record?.expiresAt).toBe(1_000 + HOOK_TRANSITION_OUTBOX_TTL_MS);
		expect(record?.request.metadata).toEqual({
			source: "codex",
			sessionId: "resume-session",
			sessionInstanceId: "process-1",
			turnId: "turn-1",
			promptId: null,
			toolUseId: null,
			elicitationId: null,
			providerAgentId: null,
			hookEventName: "PermissionRequest",
			toolName: "Bash",
			notificationType: null,
		});
	});

	it("does not queue best-effort Codex activity events", () => {
		expect(createPersistedHookTransition({ ...request(1), event: "activity" })).toBeNull();
	});

	it("persists reliable Codex SessionStart identity without requiring a turn id", () => {
		expect(
			createPersistedHookTransition({
				...request(1),
				event: "activity",
				metadata: {
					...request(1).metadata,
					hookEventName: "SessionStart",
					turnId: null,
				},
			}),
		).not.toBeNull();
	});

	it("persists Claude lifecycle events with launch fencing without requiring Codex turn identity", () => {
		expect(
			createPersistedHookTransition({
				...request(1),
				event: "activity",
				metadata: { ...request(1).metadata, source: "claude", turnId: null, promptId: "prompt-1" },
			}),
		).not.toBeNull();

		// Non-SessionStart Codex lifecycle transitions still require native turn identity.
		expect(
			createPersistedHookTransition({
				...request(1),
				metadata: { ...request(1).metadata, turnId: null },
			}),
		).toBeNull();
	});

	it("persists Pi lifecycle events with launch fencing and provider-native correlation", () => {
		const sessionStart = createPersistedHookTransition({
			...request(1),
			event: "activity",
			metadata: {
				...request(1).metadata,
				source: "pi",
				hookEventName: "session_meta",
				turnId: null,
				toolUseId: null,
			},
		});
		const permission = createPersistedHookTransition({
			...request(1),
			metadata: {
				...request(1).metadata,
				source: "pi",
				turnId: null,
				toolUseId: "pi-tool-1",
			},
		});
		const settled = createPersistedHookTransition({
			...request(1),
			metadata: {
				...request(1).metadata,
				source: "pi",
				hookEventName: "AgentSettled",
				turnId: "pi-run-1",
				toolUseId: null,
			},
		});
		const withoutLaunchFence = createPersistedHookTransition({
			...request(1),
			metadata: {
				...request(1).metadata,
				source: "pi",
				sessionInstanceId: null,
			},
		});

		expect(sessionStart).not.toBeNull();
		expect(permission?.request.metadata?.toolUseId).toBe("pi-tool-1");
		expect(settled?.request.metadata?.turnId).toBe("pi-run-1");
		expect(withoutLaunchFence).toBeNull();
	});

	it("loads pending transitions in occurrence order", async () => {
		await enqueueHookTransition(request(2, 200));
		await enqueueHookTransition(request(1, 100));

		const records = await loadPendingHookTransitions();

		expect(records.map((record) => record.request.delivery.id)).toEqual([
			"00000000-0000-4000-8000-000000000001",
			"00000000-0000-4000-8000-000000000002",
		]);
	});

	it("removes successfully replayed transitions", async () => {
		await enqueueHookTransition(request(1));
		const ingest = vi.fn(async () => ({ ok: true as const }));
		const replayer = createHookTransitionOutboxReplayer({ ingest });

		await replayer.replayOnce();

		expect(ingest).toHaveBeenCalledTimes(1);
		expect(await loadPendingHookTransitions()).toEqual([]);
		await replayer.close();
	});

	it("retains transitions when the runtime still rejects replay", async () => {
		await enqueueHookTransition(request(1));
		const replayer = createHookTransitionOutboxReplayer({
			ingest: vi.fn(async () => ({ ok: false as const, error: "not ready" })),
		});

		await replayer.replayOnce();

		expect(await loadPendingHookTransitions()).toHaveLength(1);
		await replayer.close();
	});

	it("reports the exact tasks still pending after each successful replay pass", async () => {
		await enqueueHookTransition(request(1));
		await enqueueHookTransition({
			...request(2),
			projectId: "project-2",
			taskId: "task-2",
			metadata: { ...request(2).metadata, sessionInstanceId: "process-2" },
		});
		let acceptProjectTwo = false;
		const onReplayPassCompleted = vi.fn();
		const replayer = createHookTransitionOutboxReplayer({
			ingest: vi.fn(async (input) =>
				input.projectId === "project-1" || acceptProjectTwo
					? { ok: true as const }
					: { ok: false as const, error: "not ready" },
			),
			onReplayPassCompleted,
		});

		await replayer.replayOnce();
		expect(onReplayPassCompleted).toHaveBeenLastCalledWith({
			pendingTasks: [{ projectId: "project-2", taskId: "task-2" }],
		});

		acceptProjectTwo = true;
		await replayer.replayOnce();
		expect(onReplayPassCompleted).toHaveBeenLastCalledWith({ pendingTasks: [] });
		await replayer.close();
	});

	it("scopes diagnostic aggregates to the requested project, task, and session", async () => {
		await enqueueHookTransition(request(1));
		await enqueueHookTransition({
			...request(2),
			projectId: "project-2",
			taskId: "task-2",
			metadata: { ...request(2).metadata, sessionInstanceId: "process-2" },
		});
		const replayer = createHookTransitionOutboxReplayer({
			ingest: vi.fn(async (input) =>
				input.projectId === "project-1" ? { ok: true as const } : { ok: false as const, error: "not ready" },
			),
		});

		await replayer.replayOnce();

		expect(replayer.getDiagnosticSnapshot({ projectId: "project-1", taskId: "task-1" })).toMatchObject({
			pendingRecords: 0,
			lastAttempted: 1,
			lastAcknowledged: 1,
			lastDeferred: 0,
		});
		expect(replayer.getDiagnosticSnapshot({ sessionInstanceId: "process-2" })).toMatchObject({
			pendingRecords: 1,
			lastAttempted: 1,
			lastAcknowledged: 0,
			lastDeferred: 1,
		});
		expect(replayer.getDiagnosticSnapshot({ operationId: "unrelated-operation" })).toMatchObject({
			pendingRecords: 0,
			lastAttempted: 0,
		});
		await replayer.close();
	});

	it("expires transitions instead of replaying them indefinitely", async () => {
		const input = request(1, 1_000);
		await enqueueHookTransition(input);

		expect(await loadPendingHookTransitions(Date.now() + HOOK_TRANSITION_OUTBOX_TTL_MS + 1)).toEqual([]);
	});

	it("cleans up stale atomic-write remnants", async () => {
		const outboxDirectory = join(stateHome, "hook-transition-outbox");
		const tempPath = join(outboxDirectory, "orphan.json.tmp.123");
		await mkdir(outboxDirectory, { recursive: true });
		await writeFile(tempPath, "partial", "utf8");
		await utimes(tempPath, new Date(0), new Date(0));

		await loadPendingHookTransitions(HOOK_TRANSITION_OUTBOX_TTL_MS + 1);

		expect(await readdir(outboxDirectory)).not.toContain("orphan.json.tmp.123");
	});
});
