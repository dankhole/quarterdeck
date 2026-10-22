import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const prepareAgentLaunchMock = vi.hoisted(() => vi.fn());
const ptySessionSpawnMock = vi.hoisted(() => vi.fn());

vi.mock("../../../src/terminal/agent-session-adapters.js", () => ({
	prepareAgentLaunch: prepareAgentLaunchMock,
}));

vi.mock("../../../src/terminal/pty-session.js", () => ({
	PtySession: {
		spawn: ptySessionSpawnMock,
	},
}));

import type { RuntimeHookEvent, RuntimeHookMetadata } from "../../../src/core";
import { deriveTaskIndicatorState, runtimeTaskSessionSummarySchema } from "../../../src/core";
import { InMemorySessionSummaryStore, TerminalSessionManager } from "../../../src/terminal";
import { createHooksApi } from "../../../src/trpc";

const TASK_ID = "subagent-wait";

function setupMockPtySpawn() {
	const writes: Buffer[] = [];
	ptySessionSpawnMock.mockImplementation(() => ({
		pid: 111,
		write: vi.fn((data: Buffer) => writes.push(Buffer.from(data))),
		resize: vi.fn(),
		pause: vi.fn(),
		resume: vi.fn(),
		stop: vi.fn(),
		wasInterrupted: vi.fn(() => false),
	}));
	return writes;
}

async function startClaudeTask() {
	const writes = setupMockPtySpawn();
	const manager = new TerminalSessionManager(new InMemorySessionSummaryStore());
	await manager.startTaskSession({
		taskId: TASK_ID,
		agentId: "claude",
		binary: "claude",
		args: [],
		cwd: "/tmp/subagent-wait",
		prompt: "Synthetic task",
	});
	const sessionInstanceId = manager.store.getSummary(TASK_ID)?.sessionInstanceId;
	if (!sessionInstanceId) throw new Error("Expected a session instance id.");
	const api = createHooksApi({
		runProjectOperation: async (_scope, operation) => await operation(),
		projects: { getProjectPathById: () => "/tmp/repo" },
		terminals: {
			getTerminalManagerForProject: () => manager,
			ensureTerminalManagerForProject: async () => manager,
		},
	});
	let delivery = 0;
	const startedAt = Date.now();
	const ingest = async (
		event: RuntimeHookEvent,
		hookEventName: string,
		offset: number,
		metadata: Omit<RuntimeHookMetadata, "source" | "hookEventName" | "sessionInstanceId"> = {},
	) => {
		delivery += 1;
		await expect(
			api.ingest({
				taskId: TASK_ID,
				projectId: "project-1",
				event,
				metadata: {
					source: "claude",
					hookEventName,
					sessionInstanceId,
					sessionId: "claude-session",
					promptId: "prompt-1",
					...metadata,
				},
				delivery: {
					id: `00000000-0000-4000-8000-${String(delivery).padStart(12, "0")}`,
					occurredAt: startedAt + offset,
				},
			}),
		).resolves.toEqual({ ok: true });
	};
	const summary = () => {
		const current = manager.store.getSummary(TASK_ID);
		if (!current) throw new Error("Expected the task summary.");
		return current;
	};
	return { manager, ingest, summary, writes, startedAt };
}

describe("TerminalSessionManager Claude subagent waits", () => {
	beforeEach(() => {
		vi.useFakeTimers();
		prepareAgentLaunchMock.mockReset();
		ptySessionSpawnMock.mockReset();
		prepareAgentLaunchMock.mockImplementation(async (input: { args: string[]; binary?: string }) => ({
			binary: input.binary,
			args: [...input.args],
			env: {},
		}));
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	it("surfaces a subagent permission prompt as Needs Input through hook ingest and user input", async () => {
		const { manager, ingest, summary, writes, startedAt } = await startClaudeTask();
		await ingest("to_in_progress", "UserPromptSubmit", 1);
		await ingest("to_in_progress", "PreToolUse", 2, { toolUseId: "main-agent", toolName: "Agent" });
		await ingest("to_in_progress", "PreToolUse", 10, {
			providerAgentId: "agent-a",
			toolUseId: "a-1",
			toolName: "Bash",
		});
		await ingest("to_in_progress", "PreToolUse", 11, {
			providerAgentId: "agent-b",
			toolUseId: "b-1",
			toolName: "Bash",
		});
		expect(deriveTaskIndicatorState(summary()).kind).toBe("running");

		await ingest("to_review", "PermissionRequest", 12, { providerAgentId: "agent-a", toolName: "Bash" });

		expect(summary()).toMatchObject({ state: "running", outstandingInteraction: null });
		expect(summary().subagentInteractions).toEqual([
			expect.objectContaining({ providerAgentId: "agent-a", toolUseId: "a-1", status: "waiting" }),
		]);
		expect(deriveTaskIndicatorState(summary())).toMatchObject({ kind: "approval_required", needsInput: true });

		// Other subagents and the main agent keep working; none of them answers agent-a's prompt.
		await ingest("to_in_progress", "PostToolUse", 13, {
			providerAgentId: "agent-b",
			toolUseId: "b-1",
			toolName: "Bash",
		});
		await ingest("activity", "Notification", 14, {
			providerAgentId: "agent-a",
			notificationType: "permission_prompt",
		});
		await ingest("to_in_progress", "PostToolUse", 15, { toolUseId: "main-agent", toolName: "Agent" });
		expect(deriveTaskIndicatorState(summary()).kind).toBe("approval_required");
		expect(runtimeTaskSessionSummarySchema.parse(JSON.parse(JSON.stringify(summary()))).subagentInteractions).toEqual(
			summary().subagentInteractions,
		);

		// Enter answers the dialog; the response is pending until agent-a's own hook.
		vi.setSystemTime(startedAt + 20);
		manager.writeInput(TASK_ID, Buffer.from("\r"));
		expect(writes.at(-1)).toEqual(Buffer.from("\r"));
		expect(summary().subagentInteractions?.[0]).toMatchObject({
			status: "response_submitted",
			responseKind: "submit",
		});
		expect(deriveTaskIndicatorState(summary()).kind).toBe("running");

		// A delayed duplicate request from before the answer cannot reopen the prompt.
		await ingest("to_review", "PermissionRequest", 12, { providerAgentId: "agent-a", toolName: "Bash" });
		expect(summary().subagentInteractions?.[0]?.status).toBe("response_submitted");

		await ingest("to_in_progress", "PostToolUse", 30, {
			providerAgentId: "agent-a",
			toolUseId: "a-1",
			toolName: "Bash",
		});
		expect(summary().subagentInteractions).toEqual([]);
		expect(summary().state).toBe("running");
	});

	it("keeps an uncorrelated parallel-tool wait until every candidate tool completed", async () => {
		const { ingest, summary } = await startClaudeTask();
		await ingest("to_in_progress", "UserPromptSubmit", 1);
		const child = { providerAgentId: "agent-a", toolName: "Bash" } as const;
		await ingest("to_in_progress", "PreToolUse", 10, { ...child, toolUseId: "a-1" });
		await ingest("to_in_progress", "PreToolUse", 11, { ...child, toolUseId: "a-2" });
		await ingest("to_in_progress", "PreToolUse", 12, {
			providerAgentId: "agent-a",
			toolUseId: "a-3",
			toolName: "WebFetch",
		});
		await ingest("to_review", "PermissionRequest", 13, child);
		expect(summary().subagentInteractions).toEqual([
			expect.objectContaining({ toolUseId: null, candidateToolUseIds: ["a-1", "a-2"] }),
		]);

		await ingest("to_in_progress", "PostToolUse", 20, {
			providerAgentId: "agent-a",
			toolUseId: "a-3",
			toolName: "WebFetch",
		});
		await ingest("to_in_progress", "PostToolUse", 21, { ...child, toolUseId: "a-1" });
		expect(deriveTaskIndicatorState(summary()).kind).toBe("approval_required");

		await ingest("to_in_progress", "PostToolUse", 22, { ...child, toolUseId: "a-2" });
		expect(summary().subagentInteractions).toEqual([]);
	});

	it("answers a subagent permission with a numbered choice and retires waits on completion", async () => {
		const { manager, ingest, summary, startedAt } = await startClaudeTask();
		await ingest("to_in_progress", "UserPromptSubmit", 1);
		await ingest("to_review", "PermissionRequest", 10, { providerAgentId: "agent-a", toolName: "Bash" });
		await ingest("to_review", "PermissionRequest", 11, { providerAgentId: "agent-b", toolName: "Edit" });

		vi.setSystemTime(startedAt + 20);
		manager.writeInput(TASK_ID, Buffer.from("1"));
		expect(summary().subagentInteractions?.map((interaction) => interaction.status)).toEqual([
			"response_submitted",
			"waiting",
		]);
		// Ordinary typing is not an answer.
		manager.writeInput(TASK_ID, Buffer.from("x"));
		expect(deriveTaskIndicatorState(summary()).kind).toBe("approval_required");

		await ingest("to_review", "Stop", 100);
		expect(summary()).toMatchObject({ state: "awaiting_review", reviewReason: "hook", subagentInteractions: [] });
	});
});

async function startCodexTask(codexApprovalsReviewer: "user" | "auto_review") {
	const writes = setupMockPtySpawn();
	const manager = new TerminalSessionManager(new InMemorySessionSummaryStore());
	await manager.startTaskSession({
		taskId: TASK_ID,
		agentId: "codex",
		codexApprovalsReviewer,
		binary: "codex",
		args: [],
		cwd: "/tmp/subagent-wait",
		prompt: "Synthetic task",
	});
	const sessionInstanceId = manager.store.getSummary(TASK_ID)?.sessionInstanceId;
	if (!sessionInstanceId) throw new Error("Expected a session instance id.");
	const api = createHooksApi({
		runProjectOperation: async (_scope, operation) => await operation(),
		projects: { getProjectPathById: () => "/tmp/repo" },
		terminals: {
			getTerminalManagerForProject: () => manager,
			ensureTerminalManagerForProject: async () => manager,
		},
	});
	let delivery = 0;
	const startedAt = Date.now();
	const ingest = async (
		event: RuntimeHookEvent,
		hookEventName: string,
		offset: number,
		metadata: Omit<RuntimeHookMetadata, "source" | "hookEventName" | "sessionInstanceId"> = {},
	) => {
		delivery += 1;
		await expect(
			api.ingest({
				taskId: TASK_ID,
				projectId: "project-1",
				event,
				metadata: {
					source: "codex",
					hookEventName,
					sessionInstanceId,
					sessionId: "codex-root",
					turnId: "root-turn",
					...metadata,
				},
				delivery: {
					id: `00000000-0000-4000-8000-${String(delivery).padStart(12, "0")}`,
					occurredAt: startedAt + offset,
				},
			}),
		).resolves.toEqual({ ok: true });
	};
	const summary = () => {
		const current = manager.store.getSummary(TASK_ID);
		if (!current) throw new Error("Expected the task summary.");
		return current;
	};
	return { manager, ingest, summary, writes, startedAt };
}

const CODEX_CHILD = { providerAgentId: "codex-child", turnId: "child-turn", toolName: "Bash" } as const;

describe("TerminalSessionManager Codex subagent waits", () => {
	beforeEach(() => {
		vi.useFakeTimers();
		prepareAgentLaunchMock.mockReset();
		ptySessionSpawnMock.mockReset();
		prepareAgentLaunchMock.mockImplementation(async (input: { args: string[]; binary?: string }) => ({
			binary: input.binary,
			args: [...input.args],
			env: {},
		}));
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	it("surfaces a user-reviewed subagent approval as Needs Input past the root Stop", async () => {
		const { manager, ingest, summary, writes, startedAt } = await startCodexTask("user");
		await ingest("to_in_progress", "UserPromptSubmit", 1);
		await ingest("activity", "PreToolUse", 10, { ...CODEX_CHILD, toolUseId: "child-call" });
		await ingest("to_review", "PermissionRequest", 11, CODEX_CHILD);

		expect(summary()).toMatchObject({
			state: "running",
			outstandingInteraction: null,
			resumeSessionId: "codex-root",
		});
		expect(summary().subagentInteractions).toEqual([
			expect.objectContaining({ provider: "codex", providerAgentId: "codex-child", toolUseId: "child-call" }),
		]);
		expect(deriveTaskIndicatorState(summary())).toMatchObject({ kind: "approval_required", needsInput: true });

		await ingest("to_review", "Stop", 20);
		expect(summary().state).toBe("awaiting_review");
		expect(deriveTaskIndicatorState(summary()).kind).toBe("approval_required");

		// Codex's `y` hotkey answers the subagent overlay without Enter.
		vi.setSystemTime(startedAt + 30);
		manager.writeInput(TASK_ID, Buffer.from("y"));
		expect(writes.at(-1)).toEqual(Buffer.from("y"));
		expect(summary().subagentInteractions?.[0]).toMatchObject({ status: "response_submitted" });

		// A delayed duplicate request from before the answer cannot reopen it.
		await ingest("to_review", "PermissionRequest", 11, CODEX_CHILD);
		expect(summary().subagentInteractions?.[0]?.status).toBe("response_submitted");

		await ingest("to_in_progress", "PostToolUse", 40, { ...CODEX_CHILD, toolUseId: "child-call" });
		expect(summary().subagentInteractions).toEqual([]);
		expect(summary().state).toBe("awaiting_review");
	});

	it("keeps an automatic-reviewer subagent request ordering-only", async () => {
		const { ingest, summary } = await startCodexTask("auto_review");
		await ingest("to_in_progress", "UserPromptSubmit", 1);
		await ingest("to_review", "PermissionRequest", 11, CODEX_CHILD);

		expect(summary().subagentInteractions ?? []).toEqual([]);
		expect(deriveTaskIndicatorState(summary()).kind).toBe("running");
	});
});
