import * as fsPromises from "node:fs/promises";
import { chmod, mkdir, mkdtemp, readdir, readFile, rm, stat, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { RuntimeHookIngestRequest } from "../../src/core";
import * as runtimeStateHome from "../../src/core/runtime-state-home";
import {
	abandonHookTransition,
	createHookTransitionOutboxReplayer,
	createPersistedHookTransition,
	enqueueHookTransition,
	HOOK_TRANSITION_LIVE_REPLAY_MIN_AGE_MS,
	HOOK_TRANSITION_OUTBOX_TTL_MS,
	loadPendingHookTransitions,
} from "../../src/hook-transition-outbox";
import { normalizeHookTransitionReplayMetadata } from "../../src/hook-transition-outbox-core";
import { prepareHookTransitionOutboxDirectoryCapability } from "../../src/hook-transition-outbox-private-directory";
import { QUARTERDECK_HOOK_PRIVATE_OUTBOX_ENV } from "../../src/terminal/hook-runtime-context";

vi.mock("node:fs/promises", { spy: true });

const originalStateHome = process.env.QUARTERDECK_STATE_HOME;
const originalPrivateOutboxCapability = process.env[QUARTERDECK_HOOK_PRIVATE_OUTBOX_ENV];
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

const supportedCompletions = [
	{ source: "codex", hookEventName: "Stop", event: "to_review" },
	{ source: "claude", hookEventName: "Stop", event: "to_review" },
	{ source: "pi", hookEventName: "AgentSettled", event: "to_review" },
	{ source: "pi", hookEventName: "AgentSettledBackgroundPending", event: "activity" },
] satisfies Array<{ source: string; hookEventName: string; event: RuntimeHookIngestRequest["event"] }>;

function completionRequest(index: number = 1): RuntimeHookIngestRequest {
	return {
		...request(index),
		event: "to_review",
		metadata: { ...request(index).metadata, hookEventName: "Stop" },
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
	vi.clearAllMocks();
	stateHome = await mkdtemp(join(tmpdir(), "quarterdeck-hook-outbox-"));
	process.env.QUARTERDECK_STATE_HOME = stateHome;
	delete process.env[QUARTERDECK_HOOK_PRIVATE_OUTBOX_ENV];
	if (process.platform === "win32") {
		// Synthetic storage: exercise the handoff without spawning PowerShell in
		// every outbox test. The private-directory suite owns ACL implementation.
		process.env[QUARTERDECK_HOOK_PRIVATE_OUTBOX_ENV] = await prepareHookTransitionOutboxDirectoryCapability({
			platform: "win32",
			runWindowsAclCommand: async () => ({ ok: true }),
		});
	}
});

afterEach(async () => {
	vi.restoreAllMocks();
	if (originalPrivateOutboxCapability === undefined) {
		delete process.env[QUARTERDECK_HOOK_PRIVATE_OUTBOX_ENV];
	} else {
		process.env[QUARTERDECK_HOOK_PRIVATE_OUTBOX_ENV] = originalPrivateOutboxCapability;
	}
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

	it.each(supportedCompletions)("round-trips one canonical foreground reply: %o", async (completion) => {
		const input = {
			...request(1),
			event: completion.event,
			payload: "private top-level native payload",
			delivery: { id: deliveryId(1), occurredAt: 100, payload: "private delivery payload" },
			metadata: {
				...request(1).metadata,
				source: ` ${completion.source.toUpperCase()} `,
				hookEventName: ` ${completion.hookEventName.toUpperCase()} `,
				finalMessage: "  Latest foreground answer\nwith formatting.  ",
				conversationSummaryText: "obsolete compatibility answer",
				rawPayload: { secret: "private native payload" },
			},
		};
		const original = structuredClone(input);

		expect(await enqueueHookTransition(input)).toBe(true);
		const path = join(stateHome, "hook-transition-outbox", `${deliveryId(1)}.json`);
		const raw = await readFile(path, "utf8");
		const [record] = await loadPendingHookTransitions();

		const retainedText = "Latest foreground answer\nwith formatting.";
		expect(record?.request.metadata?.finalMessage).toBe(retainedText);
		expect(normalizeHookTransitionReplayMetadata(input.event, record?.request.metadata)?.finalMessage).toBe(
			retainedText,
		);
		for (const excluded of [
			"conversationSummaryText",
			"activityText",
			"toolInputSummary",
			"transcriptPath",
			"rawPayload",
			"private top-level native payload",
			"private delivery payload",
			"private native payload",
			"obsolete compatibility answer",
			"/private/",
		]) {
			expect(raw).not.toContain(excluded);
		}
		expect(record?.request.delivery).toEqual(request(1).delivery);
		expect(input).toEqual(original);
	});

	it.each([
		{ finalMessage: null, conversationSummaryText: "  legacy answer  ", expected: "legacy answer" },
		{ finalMessage: " \n\t ", conversationSummaryText: "  fallback answer  ", expected: "fallback answer" },
		{ finalMessage: undefined, conversationSummaryText: undefined, expected: undefined },
		{ finalMessage: null, conversationSummaryText: null, expected: undefined },
		{ finalMessage: "  ", conversationSummaryText: "\n\t", expected: undefined },
	])("normalizes blank and legacy completion text: %o", ({ expected, ...text }) => {
		const input = completionRequest();
		const metadata = normalizeHookTransitionReplayMetadata(input.event, { ...input.metadata, ...text });

		expect(metadata?.finalMessage).toBe(expected);
		expect(metadata).not.toHaveProperty("conversationSummaryText");
	});

	it.each(["finalMessage", "conversationSummaryText"] as const)(
		"bounds %s before persistence and keeps repeated normalization stable",
		async (field) => {
			const input = completionRequest();
			input.metadata = {
				...input.metadata,
				finalMessage: null,
				conversationSummaryText: null,
				[field]: `  ${"a".repeat(700)}  `,
			};
			await enqueueHookTransition(input);
			const [record] = await loadPendingHookTransitions();
			const expected = `${"a".repeat(500)}\u2026`;

			expect(createPersistedHookTransition(input)?.request.metadata?.finalMessage).toBe(expected);
			const retainedText = expected;
			expect(record?.request.metadata?.finalMessage).toBe(retainedText);
			expect(normalizeHookTransitionReplayMetadata(input.event, record?.request.metadata)?.finalMessage).toBe(
				retainedText,
			);
			expect(
				await readFile(join(stateHome, "hook-transition-outbox", `${deliveryId(1)}.json`), "utf8"),
			).not.toContain("a".repeat(501));
		},
	);

	it("strips content for every unsupported provider/event/hook combination", () => {
		for (const source of ["codex", "claude", "pi", "unknown"]) {
			for (const event of ["to_review", "to_in_progress", "activity"] as const) {
				for (const hookEventName of [
					"Stop",
					"AgentSettled",
					"AgentSettledBackgroundPending",
					"SubagentStop",
					"PostCompact",
					"PreToolUse",
				]) {
					if (
						supportedCompletions.some(
							(entry) =>
								entry.source === source && entry.event === event && entry.hookEventName === hookEventName,
						)
					)
						continue;
					const metadata = normalizeHookTransitionReplayMetadata(event, {
						...request(1).metadata,
						source,
						hookEventName,
					});
					expect(metadata, `${source}/${event}/${hookEventName}`).not.toHaveProperty("finalMessage");
					expect(metadata).not.toHaveProperty("conversationSummaryText");
					expect(metadata).not.toHaveProperty("activityText");
					expect(metadata).not.toHaveProperty("toolInputSummary");
					expect(metadata).not.toHaveProperty("transcriptPath");
				}
			}
		}
	});

	it.each(supportedCompletions)("strips subagent replies: %o", async (completion) => {
		await enqueueHookTransition({
			...request(1),
			event: completion.event,
			metadata: {
				...request(1).metadata,
				source: completion.source,
				hookEventName: completion.hookEventName,
				providerAgentId: " child-agent ",
			},
		});
		const raw = await readFile(join(stateHome, "hook-transition-outbox", `${deliveryId(1)}.json`), "utf8");
		expect(raw).not.toContain("finalMessage");
		expect(raw).not.toContain("conversationSummaryText");
		const [record] = await loadPendingHookTransitions();
		expect(record?.request.metadata?.providerAgentId).toBe(" child-agent ");
	});

	it.skipIf(process.platform === "win32")(
		"protects POSIX completion storage before writing and abandonment rewrites",
		async () => {
			const directory = join(stateHome, "hook-transition-outbox");
			await mkdir(directory, { recursive: true });
			await chmod(directory, 0o755);
			const protect = vi.spyOn(fsPromises, "chmod");

			await enqueueHookTransition(completionRequest());
			expect(protect).toHaveBeenCalledWith(directory, 0o700);
			expect((await stat(directory)).mode & 0o777).toBe(0o700);
			expect((await stat(join(directory, `${deliveryId(1)}.json`))).mode & 0o777).toBe(0o600);
			await chmod(directory, 0o755);
			protect.mockClear();

			await abandonHookTransition(deliveryId(1));
			expect(protect).toHaveBeenCalledOnce();
			expect((await stat(directory)).mode & 0o777).toBe(0o700);
		},
	);

	it.skipIf(process.platform === "win32")(
		"retains content-free lifecycle delivery when POSIX protection fails",
		async () => {
			const protect = vi.spyOn(fsPromises, "chmod").mockRejectedValueOnce(new Error("mode denied"));

			await expect(enqueueHookTransition(completionRequest())).resolves.toBe(true);
			expect(protect).toHaveBeenCalledOnce();
			const [record] = await loadPendingHookTransitions();
			expect(record?.request.delivery).toEqual(completionRequest().delivery);
			expect(record?.request.metadata).not.toHaveProperty("finalMessage");
			expect(record?.request.metadata).not.toHaveProperty("conversationSummaryText");
		},
	);

	it.skipIf(process.platform === "win32")(
		"abandons lifecycle delivery without text when POSIX protection fails",
		async () => {
			await enqueueHookTransition(completionRequest());
			const path = join(stateHome, "hook-transition-outbox", `${deliveryId(1)}.json`);
			vi.spyOn(fsPromises, "chmod").mockRejectedValueOnce(new Error("mode denied"));

			await expect(abandonHookTransition(deliveryId(1), 123)).resolves.toBeUndefined();
			const record = JSON.parse(await readFile(path, "utf8"));
			expect(record.abandonedAt).toBe(123);
			expect(record.request.delivery).toEqual(completionRequest().delivery);
			expect(record.request.metadata).not.toHaveProperty("finalMessage");
			expect(record.request.metadata).not.toHaveProperty("conversationSummaryText");
			expect(await readdir(join(stateHome, "hook-transition-outbox"))).toEqual([`${deliveryId(1)}.json`]);
		},
	);

	it.each(supportedCompletions)(
		"normalizes legacy full-metadata records again on disk read: %o",
		async (completion) => {
			const input = {
				...request(1),
				event: completion.event,
				metadata: {
					...request(1).metadata,
					source: completion.source,
					hookEventName: completion.hookEventName,
					finalMessage: "  ",
					conversationSummaryText: ` ${"b".repeat(700)} `,
				},
			};
			await enqueueHookTransition(input);
			const path = join(stateHome, "hook-transition-outbox", `${deliveryId(1)}.json`);
			const record = JSON.parse(await readFile(path, "utf8"));
			// Exercise the read boundary rather than only the current writer's output.
			await writeFile(path, JSON.stringify({ ...record, request: input }), "utf8");

			const [loaded] = await loadPendingHookTransitions();
			expect(loaded?.request.metadata?.finalMessage).toBe(`${"b".repeat(500)}\u2026`);
			for (const excluded of ["conversationSummaryText", "activityText", "toolInputSummary", "transcriptPath"]) {
				expect(loaded?.request.metadata).not.toHaveProperty(excluded);
			}
			expect(loaded?.request.delivery).toEqual(input.delivery);
			expect(loaded?.expiresAt).toBe(record.expiresAt);
			expect(loaded?.enqueuedAt).toBe(record.enqueuedAt);
		},
	);

	it("strips unsupported completion text supplied directly on disk", async () => {
		await enqueueHookTransition(request(1));
		const path = join(stateHome, "hook-transition-outbox", `${deliveryId(1)}.json`);
		const record = JSON.parse(await readFile(path, "utf8"));
		await writeFile(path, JSON.stringify({ ...record, request: request(1) }), "utf8");

		const [loaded] = await loadPendingHookTransitions();
		expect(loaded?.request.metadata).not.toHaveProperty("finalMessage");
		expect(loaded?.request.metadata).not.toHaveProperty("conversationSummaryText");
	});

	it("retains Windows lifecycle delivery without writing reply content or invoking ACL preparation", async () => {
		const platformDescriptor = Object.getOwnPropertyDescriptor(process, "platform");
		if (!platformDescriptor) throw new Error("Missing process platform descriptor");
		vi.spyOn(runtimeStateHome, "getRuntimeHomePath").mockReturnValue(stateHome);
		const protect = vi.spyOn(fsPromises, "chmod");
		try {
			Object.defineProperty(process, "platform", { value: "win32" });
			delete process.env[QUARTERDECK_HOOK_PRIVATE_OUTBOX_ENV];
			await expect(enqueueHookTransition(completionRequest())).resolves.toBe(true);
			await abandonHookTransition(deliveryId(1), 123);
			const [record] = await loadPendingHookTransitions();
			expect(record?.request.delivery).toEqual(completionRequest().delivery);
			expect(record?.abandonedAt).toBe(123);
			expect(record?.request.metadata).not.toHaveProperty("finalMessage");
			expect(record?.request.metadata).not.toHaveProperty("conversationSummaryText");
			expect(protect).not.toHaveBeenCalled();
			const raw = await readFile(join(stateHome, "hook-transition-outbox", `${deliveryId(1)}.json`), "utf8");
			expect(raw).not.toContain("sensitive");
		} finally {
			Object.defineProperty(process, "platform", platformDescriptor);
		}
	});

	it.each(["prepared", "malformed", "foreign_path", "replaced_directory", "acl_failure"] as const)(
		"uses the runtime-prepared Windows capability without hook-side ACL work: %s",
		async (scenario) => {
			const acl = vi.fn(async () => ({ ok: scenario !== "acl_failure" }));
			const capability = await prepareHookTransitionOutboxDirectoryCapability({
				platform: "win32",
				runWindowsAclCommand: acl,
			});
			expect(acl).toHaveBeenCalledOnce();
			const platformDescriptor = Object.getOwnPropertyDescriptor(process, "platform");
			if (!platformDescriptor) throw new Error("Missing process platform descriptor");
			vi.spyOn(runtimeStateHome, "getRuntimeHomePath").mockReturnValue(stateHome);
			if (scenario === "malformed") {
				process.env[QUARTERDECK_HOOK_PRIVATE_OUTBOX_ENV] = "not JSON";
			} else if (scenario === "foreign_path") {
				const proof = JSON.parse(capability ?? "null");
				process.env[QUARTERDECK_HOOK_PRIVATE_OUTBOX_ENV] = JSON.stringify({
					...proof,
					path: join(stateHome, "other"),
				});
			} else if (scenario === "replaced_directory") {
				await fsPromises.rename(join(stateHome, "hook-transition-outbox"), join(stateHome, "retired-outbox"));
				await mkdir(join(stateHome, "hook-transition-outbox"));
				process.env[QUARTERDECK_HOOK_PRIVATE_OUTBOX_ENV] = capability;
			} else if (capability) {
				process.env[QUARTERDECK_HOOK_PRIVATE_OUTBOX_ENV] = capability;
			} else {
				delete process.env[QUARTERDECK_HOOK_PRIVATE_OUTBOX_ENV];
			}
			const protect = vi.spyOn(fsPromises, "chmod");
			try {
				Object.defineProperty(process, "platform", { value: "win32" });
				await expect(enqueueHookTransition(completionRequest())).resolves.toBe(true);
				await abandonHookTransition(deliveryId(1), 123);
				const [record] = await loadPendingHookTransitions();
				expect(record?.request.delivery).toEqual(completionRequest().delivery);
				expect(record?.abandonedAt).toBe(123);
				expect(record?.request.metadata?.finalMessage).toBe(
					scenario === "prepared" ? "sensitive final response" : undefined,
				);
				expect(record?.request.metadata).not.toHaveProperty("conversationSummaryText");
				expect(acl).toHaveBeenCalledOnce();
				expect(protect).not.toHaveBeenCalled();
			} finally {
				Object.defineProperty(process, "platform", platformDescriptor);
			}
		},
	);

	it("does not add permission preparation to content-free hooks", async () => {
		const protect = vi.spyOn(fsPromises, "chmod");
		await enqueueHookTransition(request(1));
		await abandonHookTransition(deliveryId(1));
		expect(protect).not.toHaveBeenCalled();
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
		expect(record?.request.metadata).not.toHaveProperty("transcriptPath");
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
