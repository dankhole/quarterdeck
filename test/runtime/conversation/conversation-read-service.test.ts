import { appendFile, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";
import {
	type ConversationEntry,
	type ConversationProviderId,
	type ConversationReadLimits,
	type ConversationReadResult,
	type ConversationTaskSessionResolver,
	createConversationReadService,
	DEFAULT_CONVERSATION_READ_LIMITS,
} from "../../../src/conversation/index.js";
import {
	_resetLoggerForTests,
	type RuntimeDiagnosticLogSink,
	setRuntimeDiagnosticLogSink,
} from "../../../src/core/index.js";
import { createTempDir } from "../../utilities/temp-dir.js";

const CLAUDE_SESSION_ID = "claude-session-fixture";
const CODEX_SESSION_ID = "codex-session-fixture";

interface ServiceHarness {
	service: ReturnType<typeof createConversationReadService>;
	sourcePath: string;
	read(maxMessages?: number): Promise<ConversationReadResult>;
	reconstruct(): ReturnType<typeof createConversationReadService>;
}

function claudeMessage(index: number, role: "assistant" | "user", text = `${role}-${index}`): string {
	return JSON.stringify({
		type: role,
		uuid: `claude-${role}-${index}`,
		sessionId: CLAUDE_SESSION_ID,
		timestamp: `2026-08-24T12:00:${String(index % 60).padStart(2, "0")}.000Z`,
		message: { role, content: [{ type: "text", text }] },
	});
}

function claudeLinkedMessage(input: {
	uuid: string;
	parentUuid: string | null;
	role: "assistant" | "user";
	text: string;
	includeSessionId?: boolean;
}): string {
	return JSON.stringify({
		type: input.role,
		uuid: input.uuid,
		parentUuid: input.parentUuid,
		...(input.includeSessionId === false ? {} : { sessionId: CLAUDE_SESSION_ID }),
		message: { role: input.role, content: [{ type: "text", text: input.text }] },
	});
}

function codexMessage(index: number, role: "assistant" | "user", text = `${role}-${index}`): string {
	return JSON.stringify({
		timestamp: `2026-08-24T12:00:${String(index % 60).padStart(2, "0")}.000Z`,
		type: "response_item",
		payload: {
			type: "message",
			id: `codex-${role}-${index}`,
			role,
			content: [{ type: role === "user" ? "input_text" : "output_text", text }],
		},
	});
}

function codexSessionMeta(sessionId = CODEX_SESSION_ID): string {
	return JSON.stringify({
		timestamp: "2026-08-24T12:00:00.000Z",
		type: "session_meta",
		payload: { id: sessionId, cwd: "/isolated/project", cli_version: "0.142.5", history_mode: "legacy" },
	});
}

function meaningfulEntries(result: ConversationReadResult): ConversationEntry[] {
	return result.entries.filter((entry) => entry.type === "message");
}

describe("ConversationReadService", () => {
	const cleanups: Array<() => void> = [];

	afterEach(() => {
		for (const cleanup of cleanups.splice(0)) cleanup();
		_resetLoggerForTests();
	});

	async function createHarness(input: {
		providerId: ConversationProviderId;
		history: string | Buffer;
		limits?: Readonly<ConversationReadLimits>;
		providerSessionId?: string;
	}): Promise<ServiceHarness> {
		const temporary = createTempDir(`conversation-${input.providerId}-`);
		cleanups.push(temporary.cleanup);
		const claudeRoot = join(temporary.path, "claude", "projects");
		const codexRoot = join(temporary.path, "codex", "sessions");
		await Promise.all([mkdir(claudeRoot, { recursive: true }), mkdir(codexRoot, { recursive: true })]);
		const providerSessionId =
			input.providerSessionId ?? (input.providerId === "claude" ? CLAUDE_SESSION_ID : CODEX_SESSION_ID);
		const sourcePath =
			input.providerId === "claude"
				? join(claudeRoot, "isolated-project", `${providerSessionId}.jsonl`)
				: join(codexRoot, "2026", "08", "24", `rollout-2026-08-24-${providerSessionId}.jsonl`);
		await mkdir(dirname(sourcePath), { recursive: true });
		await writeFile(sourcePath, input.history);

		const sessions: ConversationTaskSessionResolver = {
			resolveTaskSession: (projectId, taskId) =>
				Promise.resolve({
					projectId,
					taskId,
					agentId: input.providerId,
					providerSessionId,
				}),
		};
		const createService = () =>
			createConversationReadService({
				sessions,
				roots: { claude: [claudeRoot], codex: [codexRoot] },
				limits: input.limits,
			});
		const service = createService();
		return {
			service,
			sourcePath,
			read: async (maxMessages) =>
				await service.readRecent({
					projectId: "project-1",
					taskId: "task-1",
					...(maxMessages ? { maxMessages } : {}),
				}),
			reconstruct: createService,
		};
	}

	it("returns equivalent provider-neutral text-only shapes for normal Claude and Codex histories", async () => {
		const [claudeFixture, codexFixture] = await Promise.all([
			readFile(join(process.cwd(), "test/fixtures/conversation/claude/normal.jsonl"), "utf8"),
			readFile(join(process.cwd(), "test/fixtures/conversation/codex/normal.jsonl"), "utf8"),
		]);
		const claude = await createHarness({ providerId: "claude", history: claudeFixture });
		const codex = await createHarness({ providerId: "codex", history: codexFixture });
		const [claudeResult, codexResult] = await Promise.all([claude.read(), codex.read()]);

		expect(claudeResult.status).toBe("available");
		expect(codexResult.status).toBe("available");
		const toComparable = (result: ConversationReadResult) =>
			result.entries.map((entry) =>
				entry.type === "message"
					? { type: entry.type, role: entry.role, text: entry.text }
					: { type: entry.type, kind: entry.kind },
			);
		expect(toComparable(claudeResult)).toEqual(toComparable(codexResult));
		for (const result of [claudeResult, codexResult]) {
			for (const entry of result.entries) {
				expect(Object.keys(entry).sort()).toEqual(
					entry.type === "message" ? ["id", "role", "text", "type"] : ["id", "kind", "type"],
				);
			}
		}
		for (const serialized of [JSON.stringify(claudeResult), JSON.stringify(codexResult)]) {
			expect(serialized).not.toContain("private reasoning");
			expect(serialized).not.toContain("secret tool output");
			expect(serialized).not.toContain("/secret/path");
			expect(serialized).not.toContain("unknown_future");
		}
	});

	it("follows Claude's active parentUuid chain without exposing abandoned fork siblings", async () => {
		const history = [
			JSON.stringify({
				type: "system",
				subtype: "session_start",
				uuid: "start",
				parentUuid: null,
				sessionId: CLAUDE_SESSION_ID,
			}),
			claudeLinkedMessage({ uuid: "root-user", parentUuid: "start", role: "user", text: "root" }),
			claudeLinkedMessage({
				uuid: "root-answer",
				parentUuid: "root-user",
				role: "assistant",
				text: "root answer",
			}),
			claudeLinkedMessage({
				uuid: "abandoned-user",
				parentUuid: "root-answer",
				role: "user",
				text: "abandoned",
				includeSessionId: false,
			}),
			claudeLinkedMessage({
				uuid: "abandoned-answer",
				parentUuid: "abandoned-user",
				role: "assistant",
				text: "abandoned answer",
				includeSessionId: false,
			}),
			claudeLinkedMessage({
				uuid: "current-user",
				parentUuid: "root-answer",
				role: "user",
				text: "current",
			}),
			claudeLinkedMessage({
				uuid: "current-answer",
				parentUuid: "current-user",
				role: "assistant",
				text: "current answer",
			}),
		].join("\n");
		const harness = await createHarness({ providerId: "claude", history: `${history}\n` });
		const result = await harness.read();

		expect(result.status).toBe("available");
		expect(meaningfulEntries(result).map((entry) => (entry.type === "message" ? entry.text : null))).toEqual([
			"root",
			"root answer",
			"current",
			"current answer",
		]);
		expect(JSON.stringify(result)).not.toContain("abandoned");
	});

	it("degrades to the resolvable Claude suffix when a parentUuid chain is broken", async () => {
		const history = claudeLinkedMessage({
			uuid: "current-answer",
			parentUuid: "missing-parent",
			role: "assistant",
			text: "safe suffix",
		});
		const harness = await createHarness({ providerId: "claude", history: `${history}\n` });
		const result = await harness.read();

		expect(result).toMatchObject({ status: "degraded", reason: "history_reconstruction_incomplete" });
		expect(result.diagnostics.issues).toContain("history_reconstruction_incomplete");
		expect(meaningfulEntries(result)).toEqual([expect.objectContaining({ type: "message", text: "safe suffix" })]);
	});

	it("does not treat a long cyclic Claude lineage as a sufficient older-history frontier", async () => {
		const history = Array.from({ length: 11 }, (_, index) =>
			claudeLinkedMessage({
				uuid: `cycle-${index}`,
				parentUuid: index === 0 ? "cycle-10" : `cycle-${index - 1}`,
				role: index % 2 === 0 ? "user" : "assistant",
				text: `cycle message ${index}`,
			}),
		).join("\n");
		const harness = await createHarness({ providerId: "claude", history: `${history}\n` });
		const result = await harness.read();

		expect(result).toMatchObject({ status: "degraded", reason: "history_reconstruction_incomplete" });
		expect(result.diagnostics.issues).toContain("history_reconstruction_incomplete");
	});

	it("applies Codex thread rollback markers before projecting recent messages", async () => {
		const history = [
			codexSessionMeta(),
			codexMessage(1, "user", "keep"),
			codexMessage(2, "assistant", "keep answer"),
			codexMessage(3, "user", "rolled back"),
			codexMessage(4, "assistant", "rolled back answer"),
			JSON.stringify({
				timestamp: "2026-08-24T12:00:05.000Z",
				type: "event_msg",
				payload: { type: "thread_rolled_back", num_turns: 1 },
			}),
			codexMessage(6, "user", "replacement"),
			codexMessage(7, "assistant", "replacement answer"),
		].join("\n");
		const harness = await createHarness({ providerId: "codex", history: `${history}\n` });
		const result = await harness.read();

		expect(result.status).toBe("available");
		expect(meaningfulEntries(result).map((entry) => (entry.type === "message" ? entry.text : null))).toEqual([
			"keep",
			"keep answer",
			"replacement",
			"replacement answer",
		]);
		expect(JSON.stringify(result)).not.toContain("rolled back");
	});

	it("does not treat Codex rollback underflow as a sufficient older-history frontier", async () => {
		const history = [
			codexSessionMeta(),
			...Array.from({ length: 11 }, (_, index) => codexMessage(index + 1, index % 2 === 0 ? "user" : "assistant")),
			JSON.stringify({
				timestamp: "2026-08-24T12:00:20.000Z",
				type: "event_msg",
				payload: { type: "thread_rolled_back", num_turns: 10 },
			}),
		].join("\n");
		const harness = await createHarness({ providerId: "codex", history: `${history}\n` });
		const result = await harness.read();

		expect(result).toMatchObject({ status: "degraded", reason: "history_reconstruction_incomplete" });
		expect(result.diagnostics.issues).toContain("history_reconstruction_incomplete");
	});

	it("filters authenticated paginated Codex owner-handoff context without exposing provider injections", async () => {
		const fixture = await readFile(
			join(process.cwd(), "test/fixtures/conversation/codex/paginated-native-app-server-round-trip.jsonl"),
			"utf8",
		);
		expect(
			fixture.match(/"internal_chat_message_metadata_passthrough":\{[^}\n]*"turn_id":"turn-native-a"\}/g),
		).toHaveLength(2);
		const harness = await createHarness({ providerId: "codex", history: fixture });
		const first = await harness.read(24);
		const reconstructed = await harness.reconstruct().readRecent({
			projectId: "project-1",
			taskId: "task-1",
			maxMessages: 24,
		});
		const expectedMessages = [
			"Native marker A.",
			"Native response A.",
			"Structured marker B.",
			"Structured response B.",
			"Native marker C.",
			"Native response C with prior context.",
			"Interrupt marker D.",
			"Native recovery marker.",
			"Native recovery response with prior context.",
		];
		for (const result of [first, reconstructed]) {
			expect(result.status).toBe("available");
			expect(meaningfulEntries(result).map((entry) => (entry.type === "message" ? entry.text : null))).toEqual(
				expectedMessages,
			);
			const serialized = JSON.stringify(result);
			expect(serialized).not.toContain("<INSTRUCTIONS>");
			expect(serialized).not.toContain("<environment_context>");
			expect(serialized).not.toContain("/synthetic/project");
			expect(serialized).not.toContain("redacted");
		}
		expect(reconstructed.entries.map((entry) => entry.id)).toEqual(first.entries.map((entry) => entry.id));
	});

	it("projects the authenticated Codex post-compaction suffix without exposing its environment injection", async () => {
		const fixture = await readFile(
			join(process.cwd(), "test/fixtures/conversation/codex/paginated-compaction-round-trip.jsonl"),
			"utf8",
		);
		const harness = await createHarness({ providerId: "codex", history: fixture });
		const first = await harness.read(24);
		const reconstructed = await harness.reconstruct().readRecent({
			projectId: "project-1",
			taskId: "task-1",
			maxMessages: 24,
		});

		for (const result of [first, reconstructed]) {
			expect(result).toMatchObject({
				status: "available",
				hasOlder: true,
				incomplete: true,
				diagnostics: { issues: ["history_compacted"] },
			});
			expect(result.entries.map((entry) => (entry.type === "message" ? entry.text : entry.kind))).toEqual([
				"history_gap",
				"compacted",
				"Post-compaction marker.",
				"Post-compaction response with prior context.",
			]);
			const serialized = JSON.stringify(result);
			expect(serialized).not.toContain("<environment_context>");
			expect(serialized).not.toContain("/synthetic/project");
			expect(serialized).not.toContain("Pre-compaction marker.");
			expect(serialized).not.toContain("Sanitized prior context.");
		}
		expect(reconstructed.entries.map((entry) => entry.id)).toEqual(first.entries.map((entry) => entry.id));
	});

	it("fails closed for an unknown older Codex user record that duplicates a newer provider turn", async () => {
		const history = [
			JSON.stringify({
				timestamp: "2026-08-24T12:00:00.000Z",
				type: "session_meta",
				payload: { id: CODEX_SESSION_ID, history_mode: "paginated" },
			}),
			JSON.stringify({
				timestamp: "2026-08-24T12:00:01.000Z",
				type: "response_item",
				payload: {
					type: "message",
					id: "unknown-provider-context",
					role: "user",
					content: [{ type: "input_text", text: "provider-private-context" }],
					internal_chat_message_metadata_passthrough: { turn_id: "same-turn" },
				},
			}),
			JSON.stringify({
				timestamp: "2026-08-24T12:00:02.000Z",
				type: "response_item",
				payload: {
					type: "message",
					id: "actual-user-prompt",
					role: "user",
					content: [{ type: "input_text", text: "actual-user-text" }],
					internal_chat_message_metadata_passthrough: { turn_id: "same-turn" },
				},
			}),
		].join("\n");
		const harness = await createHarness({ providerId: "codex", history: `${history}\n` });
		const result = await harness.read(24);
		expect(result).toMatchObject({ status: "degraded", reason: "malformed_record", incomplete: true });
		expect(meaningfulEntries(result).map((entry) => (entry.type === "message" ? entry.text : null))).toEqual([
			"actual-user-text",
		]);
		expect(JSON.stringify(result)).not.toContain("provider-private-context");
	});

	it("does not trust an injected-looking Codex wrapper without its newer same-turn prompt", async () => {
		const history = [
			codexSessionMeta(),
			JSON.stringify({
				timestamp: "2026-08-24T12:00:01.000Z",
				type: "response_item",
				payload: {
					type: "message",
					id: "unpaired-provider-context",
					role: "user",
					content: [
						{
							type: "input_text",
							text: "# AGENTS.md instructions for /synthetic/project\n\n<INSTRUCTIONS>\nprivate\n</INSTRUCTIONS>",
						},
						{
							type: "input_text",
							text: "<environment_context>\nprivate\n</environment_context>",
						},
					],
					internal_chat_message_metadata_passthrough: { turn_id: "missing-newer-prompt" },
				},
			}),
		].join("\n");
		const harness = await createHarness({ providerId: "codex", history: `${history}\n` });
		const result = await harness.read(24);
		expect(result).toMatchObject({ status: "degraded", reason: "malformed_record" });
		expect(meaningfulEntries(result)).toEqual([]);
		expect(JSON.stringify(result)).not.toContain("private");
	});

	it("does not trust a single-block Codex environment wrapper without its newer same-turn prompt", async () => {
		const history = [
			codexSessionMeta(),
			JSON.stringify({
				timestamp: "2026-08-24T12:00:01.000Z",
				type: "response_item",
				payload: {
					type: "message",
					id: "unpaired-environment-context",
					role: "user",
					content: [
						{
							type: "input_text",
							text: "<environment_context>\nprivate\n</environment_context>",
						},
					],
					internal_chat_message_metadata_passthrough: { turn_id: "missing-newer-prompt" },
				},
			}),
		].join("\n");
		const harness = await createHarness({ providerId: "codex", history: `${history}\n` });
		const result = await harness.read(24);
		expect(result).toMatchObject({ status: "degraded", reason: "malformed_record" });
		expect(meaningfulEntries(result)).toEqual([]);
		expect(JSON.stringify(result)).not.toContain("private");
	});

	it("rejects an unknown Codex history mode before returning rollout content", async () => {
		const history = [
			JSON.stringify({
				timestamp: "2026-08-24T12:00:00.000Z",
				type: "session_meta",
				payload: { id: CODEX_SESSION_ID, history_mode: "future_mode" },
			}),
			codexMessage(1, "user", "must-not-return"),
		].join("\n");
		const harness = await createHarness({ providerId: "codex", history: `${history}\n` });
		const result = await harness.read();
		expect(result).toMatchObject({ status: "unsupported", reason: "format_unsupported", entries: [] });
		expect(JSON.stringify(result)).not.toContain("must-not-return");
	});

	it("rejects a declared Codex transcript version newer than the authenticated fixture gate", async () => {
		const history = [
			JSON.stringify({
				timestamp: "2026-08-24T12:00:00.000Z",
				type: "session_meta",
				payload: { id: CODEX_SESSION_ID, cli_version: "0.150.0", history_mode: "paginated" },
			}),
			codexMessage(1, "user", "must-not-return"),
		].join("\n");
		const harness = await createHarness({ providerId: "codex", history: `${history}\n` });
		const result = await harness.read();
		expect(result).toMatchObject({ status: "unsupported", reason: "format_unsupported", entries: [] });
		expect(JSON.stringify(result)).not.toContain("must-not-return");
	});

	it("keeps historical Codex transcripts readable when session_meta predates cli_version", async () => {
		const history = [
			JSON.stringify({
				timestamp: "2026-08-24T12:00:00.000Z",
				type: "session_meta",
				payload: { id: CODEX_SESSION_ID },
			}),
			codexMessage(1, "user", "historical-user-text"),
		].join("\n");
		const harness = await createHarness({ providerId: "codex", history: `${history}\n` });
		const result = await harness.read();
		expect(result.status).toBe("available");
		expect(meaningfulEntries(result)).toEqual([
			expect.objectContaining({ type: "message", role: "user", text: "historical-user-text" }),
		]);
	});

	it("normalizes the authenticated Claude SDK interrupt sentinel into a stable boundary", async () => {
		const fixture = await readFile(
			join(process.cwd(), "test/fixtures/conversation/claude/agent-sdk-round-trip.jsonl"),
			"utf8",
		);
		expect(fixture.match(/"promptId":"prompt-sdk-interrupt"/g)).toHaveLength(2);
		const harness = await createHarness({ providerId: "claude", history: fixture });
		const first = await harness.read(24);
		const reconstructed = await harness.reconstruct().readRecent({
			projectId: "project-1",
			taskId: "task-1",
			maxMessages: 24,
		});
		const expectedMessages = [
			"Native marker A.",
			"Native response A.",
			"Structured marker B.",
			"Structured response B.",
			"Native marker C.",
			"Native response C with prior context.",
			"Interrupt marker D.",
			"Native recovery marker.",
			"Native recovery response with prior context.",
		];
		for (const result of [first, reconstructed]) {
			expect(result.status).toBe("available");
			expect(meaningfulEntries(result).map((entry) => (entry.type === "message" ? entry.text : null))).toEqual(
				expectedMessages,
			);
			expect(
				result.entries.filter((entry) => entry.type === "boundary" && entry.kind === "interrupted"),
			).toHaveLength(1);
			expect(JSON.stringify(result)).not.toContain("[Request interrupted by user]");
		}
		expect(reconstructed.entries.map((entry) => entry.id)).toEqual(first.entries.map((entry) => entry.id));
	});

	it("keeps closed user-authored Claude text outside the exact interrupt-sentinel literal", async () => {
		const harness = await createHarness({
			providerId: "claude",
			history: `${claudeMessage(1, "user", "[Request interrupted by user while reviewing the design]")}\n`,
		});
		const result = await harness.read();
		expect(meaningfulEntries(result).map((entry) => (entry.type === "message" ? entry.text : null))).toEqual([
			"[Request interrupted by user while reviewing the design]",
		]);
	});

	it("selects the bounded recent tail at the default and hard message limits", async () => {
		const records = Array.from({ length: 40 }, (_, index) =>
			claudeMessage(index, index % 2 === 0 ? "user" : "assistant"),
		);
		const harness = await createHarness({ providerId: "claude", history: `${records.join("\n")}\n` });

		const defaultResult = await harness.read();
		expect(defaultResult.status).toBe("available");
		expect(meaningfulEntries(defaultResult)).toHaveLength(10);
		expect(meaningfulEntries(defaultResult).map((entry) => (entry.type === "message" ? entry.text : null))).toEqual(
			Array.from({ length: 10 }, (_, index) => `${(index + 30) % 2 === 0 ? "user" : "assistant"}-${index + 30}`),
		);
		expect(defaultResult.hasOlder).toBe(true);
		expect(defaultResult.entries[0]).toMatchObject({ type: "boundary", kind: "history_gap" });

		const hardResult = await harness.read(24);
		expect(meaningfulEntries(hardResult)).toHaveLength(24);
		const invalidResult = await harness.service.readRecent({
			projectId: "project-1",
			taskId: "task-1",
			maxMessages: 25,
		});
		expect(invalidResult).toMatchObject({ status: "unavailable", reason: "invalid_request" });
	});

	it("does not read a long source in full after finding the requested tail", async () => {
		const records = Array.from({ length: 6_000 }, (_, index) =>
			claudeMessage(index, index % 2 === 0 ? "user" : "assistant", `${index}:${"x".repeat(900)}`),
		);
		const harness = await createHarness({ providerId: "claude", history: `${records.join("\n")}\n` });
		const sourceStat = await stat(harness.sourcePath);
		const result = await harness.read();
		expect(result.status).toBe("available");
		expect(result.diagnostics.sourceBytesExamined).toBeLessThan(sourceStat.size);
		expect(result.diagnostics.sourceBytesExamined).toBeLessThan(DEFAULT_CONVERSATION_READ_LIMITS.maxSourceBytes);
		expect(result.diagnostics.recordsExamined).toBeLessThan(100);
		expect(result.hasOlder).toBe(true);
	});

	it("uses a missing Claude ancestor as a bounded frontier after proving the unique recent tail", async () => {
		const records = Array.from({ length: 200 }, (_, index) =>
			claudeLinkedMessage({
				uuid: `linked-${index}`,
				parentUuid: index === 0 ? null : `linked-${index - 1}`,
				role: index % 2 === 0 ? "user" : "assistant",
				text: `${index}:${"x".repeat(900)}`,
			}),
		);
		const harness = await createHarness({ providerId: "claude", history: `${records.join("\n")}\n` });
		const result = await harness.read();

		expect(result).toMatchObject({ status: "available", hasOlder: true, incomplete: false });
		expect(meaningfulEntries(result)).toHaveLength(10);
		expect(result.diagnostics.recordsExamined).toBeLessThan(100);
	});

	it("continues past duplicate native IDs until the requested unique tail is proven", async () => {
		const older = Array.from({ length: 20 }, (_, index) =>
			claudeMessage(index, index % 2 === 0 ? "user" : "assistant"),
		);
		const repeatedNewest = Array.from({ length: 20 }, () => claudeMessage(999, "assistant", "repeated"));
		const harness = await createHarness({
			providerId: "claude",
			history: `${[...older, ...repeatedNewest].join("\n")}\n`,
		});
		const result = await harness.read();

		expect(result.status).toBe("available");
		expect(meaningfulEntries(result)).toHaveLength(10);
		expect(
			meaningfulEntries(result).filter((entry) => entry.type === "message" && entry.text === "repeated"),
		).toHaveLength(1);
		expect(result.hasOlder).toBe(true);
	});

	it("keeps message IDs stable after append, reread, and service reconstruction", async () => {
		const history = [claudeMessage(1, "user"), claudeMessage(2, "assistant")].join("\n");
		const harness = await createHarness({ providerId: "claude", history: `${history}\n` });
		const first = await harness.read(10);
		const firstIds = new Map(
			first.entries.flatMap((entry) => (entry.type === "message" ? [[entry.text, entry.id] as const] : [])),
		);
		await appendFile(harness.sourcePath, `${claudeMessage(3, "user")}\n`, "utf8");
		const second = await harness.read(10);
		const reconstructed = await harness.reconstruct().readRecent({
			projectId: "project-1",
			taskId: "task-1",
			maxMessages: 10,
		});
		for (const result of [second, reconstructed]) {
			for (const entry of result.entries) {
				if (entry.type === "message" && firstIds.has(entry.text)) {
					expect(entry.id).toBe(firstIds.get(entry.text));
				}
			}
		}
	});

	it.each(["claude", "codex"] as const)(
		"keeps %s source-coordinate IDs stable when native message IDs are absent",
		async (providerId) => {
			const withoutNativeId = (record: string): string => {
				const parsed = JSON.parse(record) as Record<string, unknown>;
				if (providerId === "claude") {
					delete parsed.uuid;
				} else {
					const payload = parsed.payload as Record<string, unknown>;
					delete payload.id;
				}
				return JSON.stringify(parsed);
			};
			const records = [
				withoutNativeId(providerId === "claude" ? claudeMessage(1, "user") : codexMessage(1, "user")),
				withoutNativeId(providerId === "claude" ? claudeMessage(2, "assistant") : codexMessage(2, "assistant")),
			];
			const history = providerId === "codex" ? [codexSessionMeta(), ...records] : records;
			const harness = await createHarness({ providerId, history: `${history.join("\n")}\n` });
			const first = await harness.read();
			const firstIds = first.entries.flatMap((entry) => (entry.type === "message" ? [entry.id] : []));

			await appendFile(
				harness.sourcePath,
				`${withoutNativeId(providerId === "claude" ? claudeMessage(3, "user") : codexMessage(3, "user"))}\n`,
				"utf8",
			);
			const reread = await harness.reconstruct().readRecent({ projectId: "project-1", taskId: "task-1" });
			expect(reread.entries.flatMap((entry) => (entry.type === "message" ? [entry.id] : [])).slice(0, 2)).toEqual(
				firstIds,
			);
		},
	);

	it("represents compaction as a presentation boundary without duplicating older messages", async () => {
		const history = [
			claudeMessage(1, "user", "older-user"),
			claudeMessage(2, "assistant", "older-assistant"),
			JSON.stringify({
				type: "system",
				subtype: "compact_boundary",
				uuid: "compact-1",
				sessionId: CLAUDE_SESSION_ID,
			}),
			claudeMessage(3, "user", "recent-user"),
			claudeMessage(4, "assistant", "recent-assistant"),
		].join("\n");
		const harness = await createHarness({ providerId: "claude", history: `${history}\n` });
		const result = await harness.read();
		expect(result).toMatchObject({ status: "available", hasOlder: true, incomplete: true });
		expect(result.entries.map((entry) => (entry.type === "message" ? entry.text : entry.kind))).toEqual([
			"history_gap",
			"compacted",
			"recent-user",
			"recent-assistant",
		]);
	});

	it("stitches resume and restart boundaries while deduplicating native message IDs", async () => {
		const repeated = claudeMessage(1, "user", "one user message");
		const history = [
			JSON.stringify({
				type: "system",
				subtype: "session_start",
				uuid: "start-1",
				sessionId: CLAUDE_SESSION_ID,
			}),
			repeated,
			JSON.stringify({
				type: "system",
				subtype: "session_resume",
				uuid: "resume-1",
				sessionId: CLAUDE_SESSION_ID,
			}),
			repeated,
			JSON.stringify({
				type: "system",
				subtype: "session_restart",
				uuid: "restart-1",
				sessionId: CLAUDE_SESSION_ID,
			}),
			claudeMessage(2, "assistant", "continued"),
		].join("\n");
		const harness = await createHarness({ providerId: "claude", history: `${history}\n` });
		const result = await harness.read();
		expect(meaningfulEntries(result).map((entry) => (entry.type === "message" ? entry.text : null))).toEqual([
			"one user message",
			"continued",
		]);
		expect(result.entries.flatMap((entry) => (entry.type === "boundary" ? [entry.kind] : []))).toEqual([
			"started",
			"resumed",
			"restarted",
		]);
	});

	it("treats a partial tail as a barrier instead of returning untrusted older text", async () => {
		const history = [claudeMessage(1, "user"), "not-json", claudeMessage(2, "assistant"), '{"type":"assistant"'].join(
			"\n",
		);
		const harness = await createHarness({ providerId: "claude", history });
		const result = await harness.read();
		expect(result.status).toBe("degraded");
		expect(result.diagnostics.issues).toEqual(["incomplete_tail"]);
		expect(meaningfulEntries(result)).toHaveLength(0);
		expect(result.entries[0]).toMatchObject({ type: "boundary", kind: "history_gap" });
	});

	it("tolerates unknown records and empty histories", async () => {
		const unknown = await createHarness({
			providerId: "claude",
			history: `${JSON.stringify({ type: "future_record", secret: "not returned" })}\n`,
		});
		const unknownResult = await unknown.read();
		expect(unknownResult).toMatchObject({ status: "available", entries: [], incomplete: false });
		expect(JSON.stringify(unknownResult)).not.toContain("not returned");

		const empty = await createHarness({ providerId: "claude", history: "" });
		await expect(empty.read()).resolves.toMatchObject({ status: "available", entries: [], incomplete: false });
	});

	it("reports missing and mismatched exact session sources explicitly", async () => {
		const missing = await createHarness({ providerId: "claude", history: "" });
		await writeFile(missing.sourcePath, "", "utf8");
		const differentService = createConversationReadService({
			sessions: {
				resolveTaskSession: (projectId, taskId) =>
					Promise.resolve({ projectId, taskId, agentId: "claude", providerSessionId: "missing-session" }),
			},
			roots: { claude: [dirname(dirname(missing.sourcePath))], codex: [] },
		});
		await expect(differentService.readRecent({ projectId: "project-1", taskId: "task-1" })).resolves.toMatchObject({
			status: "source_missing",
			reason: "source_not_found",
		});

		const mismatch = await createHarness({
			providerId: "claude",
			history: `${claudeMessage(1, "user").replaceAll(CLAUDE_SESSION_ID, "different-session")}\n`,
		});
		await expect(mismatch.read()).resolves.toMatchObject({
			status: "session_mismatch",
			reason: "source_identity_mismatch",
		});

		const missingIdentity = await createHarness({
			providerId: "claude",
			history: `${JSON.stringify({
				type: "user",
				uuid: "message-without-session",
				message: { role: "user", content: "must not be trusted by filename alone" },
			})}\n`,
		});
		await expect(missingIdentity.read()).resolves.toMatchObject({
			status: "session_mismatch",
			reason: "source_identity_mismatch",
		});
	});

	it("bounds oversized messages, total responses, raw records, and record scanning", async () => {
		const constrainedLimits: ConversationReadLimits = {
			...DEFAULT_CONVERSATION_READ_LIMITS,
			maxMessageBytes: 128,
			maxResponseBytes: 1_200,
			maxRawRecordBytes: 1_024,
			maxRecords: 8,
			tailChunkBytes: 128,
		};
		const history = [
			claudeMessage(1, "user", "x".repeat(2_000)),
			...Array.from({ length: 10 }, (_, index) => JSON.stringify({ type: `unknown-${index}` })),
			claudeMessage(2, "assistant", "y".repeat(400)),
		].join("\n");
		const harness = await createHarness({
			providerId: "claude",
			history: `${history}\n`,
			limits: constrainedLimits,
		});
		const result = await harness.read();
		expect(result.status).toBe("degraded");
		expect(result.diagnostics.recordsExamined).toBeLessThanOrEqual(constrainedLimits.maxRecords);
		expect(result.diagnostics.issues).toEqual(expect.arrayContaining(["message_truncated", "record_limit"]));
		expect(Buffer.byteLength(JSON.stringify(result), "utf8")).toBeLessThanOrEqual(constrainedLimits.maxResponseBytes);
	});

	it("normalizes unsafe controls and invalid surrogate text while preserving Markdown and Unicode", async () => {
		const unsafeText = "**Markdown** \ud800 café\u001b[31m";
		const harness = await createHarness({
			providerId: "claude",
			history: `${claudeMessage(1, "user", unsafeText)}\n`,
		});
		const result = await harness.read();
		expect(result.status).toBe("degraded");
		const message = result.entries.find((entry) => entry.type === "message");
		expect(message).toMatchObject({ type: "message", text: "**Markdown** � café�[31m" });
		expect(result.diagnostics.issues).toContain("invalid_unicode");
	});

	it("rejects caller-supplied source identity and excludes Pi from supported adapters", async () => {
		const harness = await createHarness({ providerId: "claude", history: "" });
		const injected = await harness.service.readRecent({
			projectId: "project-1",
			taskId: "task-1",
			sourcePath: "/tmp/attacker.jsonl",
			providerSessionId: "attacker-session",
		} as never);
		expect(injected).toMatchObject({ status: "unavailable", reason: "invalid_request" });

		const pi = createConversationReadService({
			sessions: {
				resolveTaskSession: (projectId, taskId) =>
					Promise.resolve({ projectId, taskId, agentId: "pi", providerSessionId: "pi-session" }),
			},
		});
		await expect(pi.readRecent({ projectId: "project-1", taskId: "task-1" })).resolves.toMatchObject({
			status: "unsupported",
			reason: "provider_not_supported",
		});
	});

	it("returns explicit task, agent, session, root, and format availability states", async () => {
		const createIdentityService = (
			identity: Awaited<ReturnType<ConversationTaskSessionResolver["resolveTaskSession"]>>,
		) =>
			createConversationReadService({
				sessions: { resolveTaskSession: () => Promise.resolve(identity) },
				roots: { claude: ["/definitely/missing/claude-root"], codex: [] },
			});
		await expect(
			createIdentityService(null).readRecent({ projectId: "project-1", taskId: "task-1" }),
		).resolves.toMatchObject({ status: "unavailable", reason: "task_session_not_found" });
		await expect(
			createIdentityService({
				projectId: "project-1",
				taskId: "task-1",
				agentId: null,
				providerSessionId: null,
			}).readRecent({ projectId: "project-1", taskId: "task-1" }),
		).resolves.toMatchObject({ status: "unavailable", reason: "agent_not_selected" });
		await expect(
			createIdentityService({
				projectId: "project-1",
				taskId: "task-1",
				agentId: "claude",
				providerSessionId: null,
			}).readRecent({ projectId: "project-1", taskId: "task-1" }),
		).resolves.toMatchObject({ status: "unavailable", reason: "session_identity_unavailable" });
		await expect(
			createIdentityService({
				projectId: "different-project",
				taskId: "different-task",
				agentId: "claude",
				providerSessionId: CLAUDE_SESSION_ID,
			}).readRecent({ projectId: "project-1", taskId: "task-1" }),
		).resolves.toMatchObject({ status: "unavailable", reason: "task_session_not_found" });
		await expect(
			createIdentityService({
				projectId: "project-1",
				taskId: "task-1",
				agentId: "claude",
				providerSessionId: CLAUDE_SESSION_ID,
			}).readRecent({ projectId: "project-1", taskId: "task-1" }),
		).resolves.toMatchObject({ status: "unavailable", reason: "source_root_unavailable" });

		const unsupportedFormat = await createHarness({
			providerId: "codex",
			history: `${codexMessage(1, "user")}\n`,
		});
		await expect(unsupportedFormat.read()).resolves.toMatchObject({
			status: "unsupported",
			reason: "format_unsupported",
		});

		const deadline = await createHarness({
			providerId: "claude",
			history: `${claudeMessage(1, "user")}\n`,
			limits: { ...DEFAULT_CONVERSATION_READ_LIMITS, deadlineMs: -1 },
		});
		await expect(deadline.read()).resolves.toMatchObject({
			status: "unavailable",
			reason: "deadline_exceeded",
		});
	});

	it("verifies Codex session_meta identity before returning rollout messages", async () => {
		const history = [codexSessionMeta("different-session"), codexMessage(1, "user")].join("\n");
		const harness = await createHarness({ providerId: "codex", history: `${history}\n` });
		await expect(harness.read()).resolves.toMatchObject({
			status: "session_mismatch",
			reason: "source_identity_mismatch",
		});
	});

	it.each(["claude", "codex"] as const)(
		"keeps %s tail selection and native IDs stable across append and reconstruction",
		async (providerId) => {
			const records = Array.from({ length: 30 }, (_, index) =>
				providerId === "claude"
					? claudeMessage(index, index % 2 === 0 ? "user" : "assistant")
					: codexMessage(index, index % 2 === 0 ? "user" : "assistant"),
			);
			const history = providerId === "codex" ? [codexSessionMeta(), ...records] : records;
			const harness = await createHarness({ providerId, history: `${history.join("\n")}\n` });
			const first = await harness.read();
			expect(first.status).toBe("available");
			expect(meaningfulEntries(first)).toHaveLength(10);
			expect(first.hasOlder).toBe(true);
			const retained = new Map(
				first.entries.flatMap((entry) => (entry.type === "message" ? [[entry.text, entry.id] as const] : [])),
			);
			const appended =
				providerId === "claude"
					? claudeMessage(31, "assistant", "appended")
					: codexMessage(31, "assistant", "appended");
			await appendFile(harness.sourcePath, `${appended}\n`, "utf8");
			const reconstructed = await harness.reconstruct().readRecent({
				projectId: "project-1",
				taskId: "task-1",
			});
			for (const entry of reconstructed.entries) {
				if (entry.type === "message" && retained.has(entry.text)) {
					expect(entry.id).toBe(retained.get(entry.text));
				}
			}
		},
	);

	it.each(["claude", "codex"] as const)("stops %s history at an opaque partial tail", async (providerId) => {
		const first = providerId === "claude" ? claudeMessage(1, "user") : codexMessage(1, "user");
		const second = providerId === "claude" ? claudeMessage(2, "assistant") : codexMessage(2, "assistant");
		const prefix = providerId === "codex" ? `${codexSessionMeta()}\n` : "";
		const history = `${prefix}${first}\nnot-json\n${JSON.stringify({ type: "future_unknown" })}\n${second}\n{"partial":`;
		const harness = await createHarness({ providerId, history });
		const result = await harness.read();
		expect(result.status).toBe("degraded");
		expect(meaningfulEntries(result)).toHaveLength(0);
		expect(result.diagnostics.issues).toEqual(["incomplete_tail"]);
	});

	it.each(["claude", "codex"] as const)("represents %s compaction with an honest gap", async (providerId) => {
		const older = providerId === "claude" ? claudeMessage(1, "user", "older") : codexMessage(1, "user", "older");
		const compacted =
			providerId === "claude"
				? JSON.stringify({
						type: "system",
						subtype: "compact_boundary",
						uuid: "compact",
						sessionId: CLAUDE_SESSION_ID,
					})
				: JSON.stringify({ timestamp: "2026-08-24T12:00:02.000Z", type: "compacted", payload: {} });
		const recent =
			providerId === "claude" ? claudeMessage(3, "assistant", "recent") : codexMessage(3, "assistant", "recent");
		const history =
			providerId === "codex" ? [codexSessionMeta(), older, compacted, recent] : [older, compacted, recent];
		const harness = await createHarness({ providerId, history: `${history.join("\n")}\n` });
		const result = await harness.read();
		expect(result).toMatchObject({ status: "available", hasOlder: true, incomplete: true });
		expect(result.entries.map((entry) => (entry.type === "message" ? entry.text : entry.kind))).toEqual([
			"history_gap",
			"compacted",
			"recent",
		]);
	});

	it("enforces raw-record, aggregate source-byte, and serialized-response budgets", async () => {
		const rawRecordLimits: ConversationReadLimits = {
			...DEFAULT_CONVERSATION_READ_LIMITS,
			maxRawRecordBytes: 256,
			tailChunkBytes: 64,
		};
		const rawRecordHarness = await createHarness({
			providerId: "claude",
			history: `${claudeMessage(1, "user", "retained")}\n${JSON.stringify({ type: "future", data: "x".repeat(2_000) })}\n`,
			limits: rawRecordLimits,
		});
		const rawRecordResult = await rawRecordHarness.read();
		expect(rawRecordResult.status).toBe("degraded");
		expect(rawRecordResult.diagnostics.issues).toContain("oversized_record");
		expect(meaningfulEntries(rawRecordResult)).toEqual([]);

		const sourceByteLimits: ConversationReadLimits = {
			...DEFAULT_CONVERSATION_READ_LIMITS,
			maxSourceBytes: 512,
			maxRawRecordBytes: 2_048,
			tailChunkBytes: 128,
		};
		const sourceByteHarness = await createHarness({
			providerId: "claude",
			history: `${claudeMessage(1, "assistant", "z".repeat(1_500))}\n`,
			limits: sourceByteLimits,
		});
		const sourceByteResult = await sourceByteHarness.read();
		expect(sourceByteResult.status).toBe("degraded");
		expect(sourceByteResult.diagnostics.sourceBytesExamined).toBeLessThanOrEqual(sourceByteLimits.maxSourceBytes);
		expect(sourceByteResult.diagnostics.issues).toContain("source_byte_limit");

		const responseLimits: ConversationReadLimits = {
			...DEFAULT_CONVERSATION_READ_LIMITS,
			maxMessageBytes: 1_024,
			maxResponseBytes: 1_800,
		};
		const responseHarness = await createHarness({
			providerId: "claude",
			history: `${Array.from({ length: 8 }, (_, index) =>
				claudeMessage(index, index % 2 === 0 ? "user" : "assistant", `${index}:${"r".repeat(900)}`),
			).join("\n")}\n`,
			limits: responseLimits,
		});
		const responseResult = await responseHarness.read();
		expect(responseResult.status).toBe("degraded");
		expect(responseResult.diagnostics.issues).toContain("response_truncated");
		expect(Buffer.byteLength(JSON.stringify(responseResult), "utf8")).toBeLessThanOrEqual(
			responseLimits.maxResponseBytes,
		);
		expect(Buffer.byteLength(JSON.stringify(responseResult.diagnostics), "utf8")).toBeLessThanOrEqual(
			responseLimits.maxDiagnosticBytes,
		);
	});

	it("does not cross an oversized Codex record that may replace older logical history", async () => {
		const limits: ConversationReadLimits = {
			...DEFAULT_CONVERSATION_READ_LIMITS,
			maxRawRecordBytes: 256,
			tailChunkBytes: 64,
		};
		const oversizedCompaction = JSON.stringify({
			timestamp: "2026-08-24T12:00:02.000Z",
			type: "compacted",
			payload: { replacement_history: ["x".repeat(2_000)] },
		});
		const history = [
			codexSessionMeta(),
			codexMessage(1, "user", "pre-compaction"),
			oversizedCompaction,
			codexMessage(3, "assistant", "safe recent suffix"),
		].join("\n");
		const harness = await createHarness({ providerId: "codex", history: `${history}\n`, limits });
		const result = await harness.read();

		expect(result).toMatchObject({ status: "degraded", reason: "oversized_record", hasOlder: true });
		expect(meaningfulEntries(result)).toEqual([
			expect.objectContaining({ type: "message", text: "safe recent suffix" }),
		]);
		expect(JSON.stringify(result)).not.toContain("pre-compaction");
	});

	it("treats invalid UTF-8 as an opaque barrier without exposing older text or raw bytes", async () => {
		const history = Buffer.concat([
			Buffer.from(`${claudeMessage(1, "user", "valid text")}\n`, "utf8"),
			Buffer.from([0xff, 0xfe, 0x0a]),
		]);
		const harness = await createHarness({ providerId: "claude", history });
		const result = await harness.read();
		expect(result.status).toBe("degraded");
		expect(result.diagnostics.issues).toContain("invalid_unicode");
		expect(meaningfulEntries(result)).toEqual([]);
		expect(JSON.stringify(result)).not.toContain("fffe");
	});

	it("emits content-free conversation diagnostics and logs", async () => {
		type LogCandidate = Parameters<RuntimeDiagnosticLogSink["recordLog"]>[0];
		const candidates: LogCandidate[] = [];
		setRuntimeDiagnosticLogSink({
			recordLog: (candidate) => {
				if (candidate.tag === "conversation-read") candidates.push(candidate);
			},
		});
		const sentinel = "SENTINEL_CONVERSATION_CONTENT";
		const pathSentinel = "/private/SENTINEL_PROVIDER_PATH";
		const harness = await createHarness({
			providerId: "claude",
			history: `${claudeMessage(1, "user", sentinel)}\n${JSON.stringify({ type: "future", path: pathSentinel })}\n`,
		});
		const result = await harness.read();
		expect(result.status).toBe("available");
		expect(candidates).toHaveLength(1);
		const serializedLogs = JSON.stringify(candidates);
		expect(serializedLogs).not.toContain(sentinel);
		expect(serializedLogs).not.toContain(pathSentinel);
		expect(serializedLogs).not.toContain(harness.sourcePath);
		expect(candidates[0]).toMatchObject({
			level: "debug",
			tag: "conversation-read",
			message: "conversation read completed",
			data: expect.objectContaining({
				projectId: "project-1",
				taskId: "task-1",
				status: "available",
				returnedMessages: 1,
			}),
		});
	});
});
