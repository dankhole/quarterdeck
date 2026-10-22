import { mkdir, mkdtemp, readdir, readFile, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { RuntimeHookIngestRequest } from "../../src/core";
import {
	abandonHookTransition,
	createHookTransitionOutboxReplayer,
	createPersistedHookTransition,
	enqueueHookTransition,
	HOOK_TRANSITION_LIVE_REPLAY_MIN_AGE_MS,
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

function deliveryId(index: number): string {
	return `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`;
}

/** Writes a record as a writer that enqueued it at `enqueuedAt` would have. */
async function writeRecord(
	input: RuntimeHookIngestRequest,
	enqueuedAt: number,
	options: { omitEnqueuedAt?: boolean } = {},
): Promise<void> {
	const record = createPersistedHookTransition(input, enqueuedAt);
	if (!record) throw new Error("Expected a replayable transition.");
	const { enqueuedAt: _enqueuedAt, ...legacyRecord } = record;
	const directory = join(stateHome, "hook-transition-outbox");
	await mkdir(directory, { recursive: true });
	await writeFile(
		join(directory, `${record.request.delivery.id}.json`),
		JSON.stringify(options.omitEnqueuedAt ? legacyRecord : record),
		"utf8",
	);
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
		expect(record?.enqueuedAt).toBe(1_000);
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

	it.each([
		{ sessionStartSource: "clear" as const, transcriptPath: null, hasTranscript: false },
		{ sessionStartSource: undefined, transcriptPath: "/private/navigation.jsonl", hasTranscript: true },
	])("retains content-free SessionStart navigation evidence through disk replay: %o", async (evidence) => {
		await enqueueHookTransition({
			...request(1),
			event: "activity",
			metadata: {
				...request(1).metadata,
				hookEventName: "SessionStart",
				turnId: null,
				sessionStartSource: evidence.sessionStartSource,
				transcriptPath: evidence.transcriptPath,
			},
		});
		const [record] = await loadPendingHookTransitions();
		expect(record?.request.metadata?.sessionStartSource).toBe(evidence.sessionStartSource);
		expect(record?.request.metadata?.sessionStartHasTranscript).toBe(evidence.hasTranscript);
		expect(record?.request.metadata?.transcriptPath).toBeNull();
		expect(JSON.stringify(record)).not.toContain("/private/");
		if (!record) throw new Error("Missing persisted hook transition");
		expect(createPersistedHookTransition(record.request)?.request.metadata?.sessionStartHasTranscript).toBe(
			evidence.hasTranscript,
		);
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

	it("adopts an abandoned record immediately while holding one its writer may still deliver", async () => {
		const now = Date.now();
		// Delivery time predates the bound, but enqueue time decides whether a writer may be live.
		await enqueueHookTransition(request(1, now - HOOK_TRANSITION_LIVE_REPLAY_MIN_AGE_MS - 1_000));
		await enqueueHookTransition(request(2, now - HOOK_TRANSITION_LIVE_REPLAY_MIN_AGE_MS - 1_000));
		await abandonHookTransition(deliveryId(2));
		const ingest = vi.fn(async (_input: RuntimeHookIngestRequest) => ({ ok: true as const }));
		const onReplayPassCompleted = vi.fn();
		const replayer = createHookTransitionOutboxReplayer({ ingest, intervalMs: 60_000, onReplayPassCompleted });

		replayer.start();
		await vi.waitFor(() => expect(onReplayPassCompleted).toHaveBeenCalledOnce());
		expect(ingest.mock.calls.map(([input]) => input.delivery?.id)).toEqual([deliveryId(2)]);
		expect(onReplayPassCompleted).toHaveBeenLastCalledWith({
			pendingTasks: [{ projectId: "project-1", taskId: "task-1" }],
		});
		expect((await loadPendingHookTransitions()).map((record) => record.request.delivery.id)).toEqual([deliveryId(1)]);
		await replayer.close();

		// Startup replay runs before clients connect and adopts every record.
		await replayer.replayOnce();
		expect(ingest).toHaveBeenCalledTimes(2);
		expect(await loadPendingHookTransitions()).toEqual([]);
	});

	it("adopts an unmarked record once its writer could no longer be delivering it", async () => {
		const now = Date.now();
		const pastWriterBound = now - HOOK_TRANSITION_LIVE_REPLAY_MIN_AGE_MS - 1_000;
		// A writer killed by its provider's hook timeout never marks its record.
		await writeRecord(request(1, now), pastWriterBound);
		// Records from older writers carry no enqueue time; it derives from their expiry.
		await writeRecord(request(2, now), pastWriterBound, { omitEnqueuedAt: true });
		await enqueueHookTransition(request(3, now));
		const ingest = vi.fn(async (_input: RuntimeHookIngestRequest) => ({ ok: true as const }));
		const onReplayPassCompleted = vi.fn();
		const replayer = createHookTransitionOutboxReplayer({ ingest, intervalMs: 60_000, onReplayPassCompleted });

		replayer.start();
		await vi.waitFor(() => expect(onReplayPassCompleted).toHaveBeenCalledOnce());
		expect(ingest.mock.calls.map(([input]) => input.delivery?.id)).toEqual([deliveryId(1), deliveryId(2)]);
		expect((await loadPendingHookTransitions()).map((record) => record.request.delivery.id)).toEqual([deliveryId(3)]);
		await replayer.close();
	});

	it("does not restore a record that replay already acknowledged when its writer gives up", async () => {
		await abandonHookTransition(deliveryId(1));

		expect(await loadPendingHookTransitions()).toEqual([]);
	});

	it("runs a complete replay after an active periodic pass instead of joining it", async () => {
		const now = Date.now();
		await writeRecord(request(1, now), now - HOOK_TRANSITION_LIVE_REPLAY_MIN_AGE_MS - 1_000);
		await enqueueHookTransition(request(2, now));
		let releaseFirst!: () => void;
		const firstDelivery = new Promise<void>((resolve) => {
			releaseFirst = resolve;
		});
		const ingest = vi.fn(async (input: RuntimeHookIngestRequest) => {
			if (input.delivery?.id === deliveryId(1)) await firstDelivery;
			return { ok: true as const };
		});
		const replayer = createHookTransitionOutboxReplayer({ ingest, intervalMs: 60_000 });

		replayer.start();
		await vi.waitFor(() => expect(ingest).toHaveBeenCalledOnce());
		let completed = false;
		const complete = replayer.replayOnce().then(() => {
			completed = true;
		});
		releaseFirst();
		await complete;

		expect(completed).toBe(true);
		expect(ingest.mock.calls.map(([input]) => input.delivery?.id)).toEqual([deliveryId(1), deliveryId(2)]);
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

	it("reports a held record as pending without attempting it", async () => {
		await enqueueHookTransition(request(1));
		const ingest = vi.fn(async () => ({ ok: true as const }));
		const onReplayPassCompleted = vi.fn();
		const replayer = createHookTransitionOutboxReplayer({ ingest, intervalMs: 60_000, onReplayPassCompleted });

		replayer.start();
		await vi.waitFor(() => expect(onReplayPassCompleted).toHaveBeenCalledOnce());

		expect(ingest).not.toHaveBeenCalled();
		expect(onReplayPassCompleted).toHaveBeenLastCalledWith({
			pendingTasks: [{ projectId: "project-1", taskId: "task-1" }],
		});
		expect(replayer.getDiagnosticSnapshot()).toMatchObject({ pendingRecords: 1, lastAttempted: 0 });
		await replayer.close();
	});

	it("does not mark a file that is not the writer's own outbox record", async () => {
		const outboxDirectory = join(stateHome, "hook-transition-outbox");
		await mkdir(outboxDirectory, { recursive: true });
		const path = join(outboxDirectory, `${deliveryId(1)}.json`);
		const foreign = JSON.stringify({
			version: 1,
			expiresAt: Date.now() + 1_000,
			request: { delivery: { id: deliveryId(2) } },
		});
		await writeFile(path, foreign, "utf8");

		await abandonHookTransition(deliveryId(1));

		expect(await readFile(path, "utf8")).toBe(foreign);
	});

	it("tolerates an unrecognized extra field on a record (forward compatibility)", async () => {
		await enqueueHookTransition(request(1));
		const [record] = await loadPendingHookTransitions();
		if (!record) throw new Error("Missing persisted hook transition");
		const outboxDirectory = join(stateHome, "hook-transition-outbox");
		const [entry] = await readdir(outboxDirectory);
		if (!entry) throw new Error("Missing outbox record file");
		const path = join(outboxDirectory, entry);
		const raw = JSON.parse(await readFile(path, "utf8"));
		await writeFile(path, JSON.stringify({ ...raw, someFutureField: "ignored" }), "utf8");

		const [reloaded] = await loadPendingHookTransitions();
		expect(reloaded?.request.delivery.id).toBe(record.request.delivery.id);
	});
});
