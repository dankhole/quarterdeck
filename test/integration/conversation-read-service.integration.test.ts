import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";
import {
	ConversationSourceHintStore,
	type ConversationTaskSessionResolver,
	createConversationReadService,
	DEFAULT_CONVERSATION_READ_LIMITS,
} from "../../src/conversation/index.js";
import { InMemorySessionSummaryStore } from "../../src/terminal/index.js";
import { createTestTaskSessionSummary } from "../utilities/task-session-factory.js";
import { createTempDir } from "../utilities/temp-dir.js";

describe("conversation read service integration", () => {
	const cleanups: Array<() => void> = [];

	afterEach(() => {
		for (const cleanup of cleanups.splice(0)) cleanup();
	});

	it("reads fake provider history without mutating any runtime or provider-owned state", async () => {
		const temporary = createTempDir("conversation-read-integration-");
		cleanups.push(temporary.cleanup);
		const claudeRoot = join(temporary.path, "home", ".claude", "projects");
		const sourcePath = join(claudeRoot, "isolated-project", "claude-session-1.jsonl");
		await mkdir(join(claudeRoot, "isolated-project"), { recursive: true });
		const history = [
			JSON.stringify({
				type: "user",
				uuid: "user-1",
				sessionId: "claude-session-1",
				message: { role: "user", content: [{ type: "text", text: "What remains?" }] },
			}),
			JSON.stringify({
				type: "assistant",
				uuid: "assistant-1",
				sessionId: "claude-session-1",
				message: { role: "assistant", content: [{ type: "text", text: "Only validation remains." }] },
			}),
		].join("\n");
		await writeFile(sourcePath, `${history}\n`, "utf8");

		const store = new InMemorySessionSummaryStore();
		store.hydrateFromRecord({
			"task-1": createTestTaskSessionSummary({
				taskId: "task-1",
				state: "awaiting_review",
				reviewReason: "attention",
				agentId: "claude",
				resumeSessionId: "claude-session-1",
				pid: 4321,
				latestHookActivity: {
					hookEventName: "Notification",
					notificationType: "agent_needs_input",
					activityText: "Needs input",
				},
			}),
		});
		const unrelatedRuntimeOwners = {
			boardRevision: 17,
			lifecycleJournal: [{ operationId: "operation-1", status: "completed" }],
			terminal: { inputWrites: 3, outputBytes: 2_048, processInstanceId: "process-1" },
			hookDeliveries: 9,
			taskMetadata: { branch: "feature/example", assignedWorktree: join(temporary.path, "worktree") },
		};
		const sessions: ConversationTaskSessionResolver = {
			resolveTaskSession: (projectId, taskId) => {
				const summary = store.getSummary(taskId);
				return Promise.resolve(
					summary
						? {
								projectId,
								taskId,
								agentId: summary.agentId,
								providerSessionId: summary.resumeSessionId ?? null,
							}
						: null,
				);
			},
		};
		const createService = () =>
			createConversationReadService({
				sessions,
				roots: { claude: [claudeRoot], codex: [] },
			});

		const summaryBefore = store.getSummary("task-1");
		const ownersBefore = structuredClone(unrelatedRuntimeOwners);
		const contentBefore = await readFile(sourcePath);
		const statBefore = await stat(sourcePath);
		const first = await createService().readRecent({ projectId: "project-1", taskId: "task-1" });
		const second = await createService().readRecent({ projectId: "project-1", taskId: "task-1" });

		expect(first.status).toBe("available");
		expect(first.entries).toEqual(second.entries);
		expect(store.getSummary("task-1")).toEqual(summaryBefore);
		expect(unrelatedRuntimeOwners).toEqual(ownersBefore);
		expect(await readFile(sourcePath)).toEqual(contentBefore);
		const statAfter = await stat(sourcePath);
		expect(statAfter.size).toBe(statBefore.size);
		expect(statAfter.mtimeMs).toBe(statBefore.mtimeMs);
	});

	it("uses only an admitted server-owned Claude hook hint and still validates its root and session", async () => {
		const temporary = createTempDir("conversation-hint-integration-");
		cleanups.push(temporary.cleanup);
		const claudeRoot = join(temporary.path, "claude", "projects");
		const sourcePath = join(claudeRoot, "project", "claude-session-1.jsonl");
		await mkdir(join(claudeRoot, "project"), { recursive: true });
		await writeFile(
			sourcePath,
			`${JSON.stringify({
				type: "user",
				uuid: "user-1",
				sessionId: "claude-session-1",
				message: { role: "user", content: "Server-owned hint" },
			})}\n`,
			"utf8",
		);
		await Promise.all(
			Array.from({ length: 5 }, (_, index) => writeFile(join(claudeRoot, `unrelated-${index}.jsonl`), "{}\n")),
		);
		const hints = new ConversationSourceHintStore();
		hints.recordClaudeHookHint({
			projectId: "project-1",
			taskId: "task-1",
			expectedProviderSessionId: "claude-session-1",
			metadata: {
				source: "claude",
				sessionId: "claude-session-1",
				transcriptPath: sourcePath,
			},
		});
		const service = createConversationReadService({
			sessions: {
				resolveTaskSession: (projectId, taskId) =>
					Promise.resolve({
						projectId,
						taskId,
						agentId: "claude",
						providerSessionId: "claude-session-1",
					}),
			},
			hints,
			roots: { claude: [claudeRoot], codex: [] },
			limits: { ...DEFAULT_CONVERSATION_READ_LIMITS, maxLookupEntries: 1 },
		});
		const result = await service.readRecent({ projectId: "project-1", taskId: "task-1" });
		expect(result).toMatchObject({
			status: "available",
			diagnostics: { lookupEntriesExamined: 0 },
		});
		expect(result.entries).toEqual([
			expect.objectContaining({ type: "message", role: "user", text: "Server-owned hint" }),
		]);
	});
});
