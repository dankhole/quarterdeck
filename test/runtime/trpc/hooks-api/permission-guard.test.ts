import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const prepareAgentLaunchMock = vi.hoisted(() => vi.fn());
const ptySessionSpawnMock = vi.hoisted(() => vi.fn());

vi.mock("../../../../src/terminal/agent-session-adapters.js", () => ({
	prepareAgentLaunch: prepareAgentLaunchMock,
}));

vi.mock("../../../../src/terminal/pty-session.js", () => ({
	PtySession: { spawn: ptySessionSpawnMock },
}));

import type { RuntimeHookEvent, RuntimeHookMetadata } from "../../../../src/core";
import { InMemorySessionSummaryStore, TerminalSessionManager } from "../../../../src/terminal";
import { createHooksApi } from "../../../../src/trpc";

interface MockSpawnRequest {
	onExit?: (event: { exitCode: number | null }) => void;
}

function createMockPtySession(pid: number, request: MockSpawnRequest) {
	return {
		pid,
		write: vi.fn(),
		resize: vi.fn(),
		pause: vi.fn(),
		resume: vi.fn(),
		stop: vi.fn(),
		wasInterrupted: vi.fn(() => false),
		triggerExit: (exitCode: number | null) => request.onExit?.({ exitCode }),
	};
}

async function createHarness(
	agentId: "codex" | "claude",
	taskId: string,
	options: { codexApprovalsReviewer?: "inherit" | "user" | "auto_review" } = {},
) {
	const manager = new TerminalSessionManager(new InMemorySessionSummaryStore());
	await manager.startTaskSession({
		taskId,
		agentId,
		binary: agentId,
		args: [],
		cwd: `/tmp/${taskId}`,
		prompt: "Test lifecycle",
		codexApprovalsReviewer: options.codexApprovalsReviewer,
	});
	const sessionInstanceId = manager.store.getSummary(taskId)?.sessionInstanceId;
	if (!sessionInstanceId) throw new Error("Missing test session identity.");
	const api = createHooksApi({
		projects: { getProjectPathById: () => "/tmp/project-1" },
		terminals: {
			getTerminalManagerForProject: () => manager,
			ensureTerminalManagerForProject: async () => manager,
		},
		captureTaskTurnCheckpoint: vi.fn(async ({ taskId: checkpointTaskId, turn }) => ({
			turn,
			ref: `refs/quarterdeck/checkpoints/${checkpointTaskId}/turn/${turn}`,
			commit: "abc123",
			createdAt: turn * 100,
		})),
		deleteTaskTurnCheckpointRef: vi.fn(async () => undefined),
		scheduleHookBackgroundTask: (task) => task(),
	});
	let deliveryIndex = 0;
	let occurredAt = Date.now();
	const ingest = async (
		event: RuntimeHookEvent,
		metadata: RuntimeHookMetadata,
		options: { occurredAt?: number } = {},
	) => {
		deliveryIndex += 1;
		occurredAt = Math.max(Date.now(), occurredAt + 1);
		return await api.ingest({
			taskId,
			projectId: "project-1",
			event,
			metadata: { source: agentId, sessionInstanceId, ...metadata },
			delivery: {
				id: `00000000-0000-4000-8000-${String(deliveryIndex).padStart(12, "0")}`,
				occurredAt: options.occurredAt ?? occurredAt,
			},
		});
	};
	return { manager, ingest };
}

describe("hook-ingest provider interaction lifecycle", () => {
	beforeEach(() => {
		prepareAgentLaunchMock.mockReset();
		ptySessionSpawnMock.mockReset();
		prepareAgentLaunchMock.mockImplementation(async (input: { binary?: string; args: string[] }) => ({
			binary: input.binary,
			args: [...input.args],
			env: {},
		}));
		ptySessionSpawnMock.mockImplementation((request: MockSpawnRequest) => createMockPtySession(1234, request));
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("correlates Claude automatic denial by tool identity and waits for new work evidence", async () => {
		const { manager, ingest } = await createHarness("claude", "task-claude-deny");

		await ingest("activity", {
			hookEventName: "PreToolUse",
			promptId: "prompt-1",
			toolUseId: "tool-1",
			toolName: "Bash",
		});
		await ingest("to_review", {
			hookEventName: "PermissionRequest",
			promptId: "prompt-1",
			toolName: "Bash",
		});
		expect(manager.store.getSummary("task-claude-deny")?.outstandingInteraction).toMatchObject({
			status: "waiting",
			toolUseId: "tool-1",
			promptId: "prompt-1",
		});

		await ingest("activity", {
			hookEventName: "PermissionDenied",
			promptId: "prompt-1",
			toolUseId: "tool-1",
			toolName: "Bash",
		});
		expect(manager.store.getSummary("task-claude-deny")?.outstandingInteraction).toMatchObject({
			status: "response_submitted",
			responseKind: "provider_denied",
		});

		await ingest("activity", {
			hookEventName: "PreToolUse",
			promptId: "prompt-1",
			toolUseId: "tool-2",
			toolName: "Read",
		});
		expect(manager.store.getSummary("task-claude-deny")).toMatchObject({
			state: "running",
			reviewReason: null,
			outstandingInteraction: null,
		});
	});

	it("keeps a manually denied Claude response pending until Stop confirms the turn ended", async () => {
		const { manager, ingest } = await createHarness("claude", "task-claude-manual-deny");
		await ingest("activity", {
			hookEventName: "PreToolUse",
			promptId: "prompt-1",
			toolUseId: "tool-1",
			toolName: "Bash",
		});
		await ingest("to_review", {
			hookEventName: "PermissionRequest",
			promptId: "prompt-1",
			toolName: "Bash",
		});

		manager.writeInput("task-claude-manual-deny", Buffer.from("n\n"), {
			explicitUserSubmission: true,
		});
		expect(manager.store.getSummary("task-claude-manual-deny")?.outstandingInteraction).toMatchObject({
			status: "response_submitted",
			responseKind: "submit",
		});

		await ingest("to_review", { hookEventName: "Stop", promptId: "prompt-1" });
		expect(manager.store.getSummary("task-claude-manual-deny")).toMatchObject({
			state: "awaiting_review",
			reviewReason: "hook",
			outstandingInteraction: null,
		});
	});

	it("keeps Claude approval response pending until the exact PostToolUse arrives", async () => {
		const { manager, ingest } = await createHarness("claude", "task-claude-approve");
		await ingest("activity", {
			hookEventName: "PreToolUse",
			promptId: "prompt-1",
			toolUseId: "tool-1",
			toolName: "Bash",
		});
		await ingest("to_review", {
			hookEventName: "PermissionRequest",
			promptId: "prompt-1",
			toolName: "Bash",
		});

		manager.writeInput("task-claude-approve", Buffer.from("y\n"), { explicitUserSubmission: true });
		expect(manager.store.getSummary("task-claude-approve")?.outstandingInteraction?.status).toBe(
			"response_submitted",
		);

		await ingest("to_in_progress", {
			hookEventName: "PostToolUse",
			promptId: "prompt-1",
			toolUseId: "tool-other",
			toolName: "Read",
		});
		expect(manager.store.getSummary("task-claude-approve")?.state).toBe("awaiting_review");

		await ingest("to_in_progress", {
			hookEventName: "PostToolUse",
			promptId: "prompt-1",
			toolUseId: "tool-1",
			toolName: "Bash",
		});
		expect(manager.store.getSummary("task-claude-approve")).toMatchObject({
			state: "running",
			outstandingInteraction: null,
		});
	});

	it("converges a Codex y approval through real hook ingest only after PostToolUse", async () => {
		const { manager, ingest } = await createHarness("codex", "task-codex-approve-y");
		await ingest("activity", {
			hookEventName: "PreToolUse",
			turnId: "turn-1",
			toolUseId: "tool-1",
			toolName: "Bash",
		});
		await ingest("to_review", {
			hookEventName: "PermissionRequest",
			turnId: "turn-1",
			toolName: "Bash",
		});

		manager.writeInput("task-codex-approve-y", Buffer.from("y"));
		expect(manager.store.getSummary("task-codex-approve-y")).toMatchObject({
			state: "awaiting_review",
			outstandingInteraction: {
				status: "response_submitted",
				responseKind: "submit",
			},
		});

		await ingest("to_in_progress", {
			hookEventName: "PostToolUse",
			turnId: "turn-1",
			toolUseId: "tool-1",
			toolName: "Bash",
		});

		expect(manager.store.getSummary("task-codex-approve-y")).toMatchObject({
			state: "running",
			reviewReason: null,
			outstandingInteraction: null,
		});
	});

	it("does not advertise Codex auto-review requests as user-facing input", async () => {
		const { manager, ingest } = await createHarness("codex", "task-codex-auto-review", {
			codexApprovalsReviewer: "auto_review",
		});
		await ingest("activity", {
			hookEventName: "PreToolUse",
			turnId: "turn-1",
			toolUseId: "tool-1",
			toolName: "Bash",
		});
		await ingest("to_review", {
			hookEventName: "PermissionRequest",
			turnId: "turn-1",
			toolName: "Bash",
		});

		expect(manager.store.getSummary("task-codex-auto-review")).toMatchObject({
			state: "running",
			reviewReason: null,
			outstandingInteraction: null,
		});

		await ingest("to_in_progress", {
			hookEventName: "PostToolUse",
			turnId: "turn-1",
			toolUseId: "tool-1",
			toolName: "Bash",
		});
		expect(manager.store.getSummary("task-codex-auto-review")).toMatchObject({
			state: "running",
			reviewReason: null,
			outstandingInteraction: null,
		});
	});

	it("converges a numbered Codex approval when later foreground work proves progress", async () => {
		const { manager, ingest } = await createHarness("codex", "task-codex-approve-number");
		await ingest("activity", {
			hookEventName: "PreToolUse",
			turnId: "turn-1",
			toolUseId: "tool-1",
			toolName: "Bash",
		});
		await ingest("to_review", {
			hookEventName: "PermissionRequest",
			turnId: "turn-1",
			toolName: "Bash",
		});

		manager.writeInput("task-codex-approve-number", Buffer.from("1"));
		const submittedSummary = manager.store.getSummary("task-codex-approve-number");
		expect(submittedSummary).toMatchObject({
			state: "awaiting_review",
			outstandingInteraction: {
				status: "response_submitted",
				responseKind: "submit",
			},
		});

		// Codex does not provide a dedicated approval acknowledgement. A later
		// foreground tool start is sufficient current provider evidence even when
		// the matching PostToolUse never arrives.
		await ingest(
			"activity",
			{
				hookEventName: "PreToolUse",
				turnId: "turn-1",
				toolUseId: "tool-2",
				toolName: "Read",
			},
			{
				occurredAt:
					Math.max(
						submittedSummary?.outstandingInteraction?.openedAt ?? 0,
						submittedSummary?.outstandingInteraction?.updatedAt ?? 0,
					) + 1,
			},
		);
		expect(manager.store.getSummary("task-codex-approve-number")).toMatchObject({
			state: "running",
			reviewReason: null,
			outstandingInteraction: null,
		});
	});

	it("retires an obsolete Codex wait when hook ordering admits a newer foreground turn", async () => {
		const { manager, ingest } = await createHarness("codex", "task-codex-new-turn");
		await ingest("to_review", {
			hookEventName: "PermissionRequest",
			turnId: "turn-1",
			toolUseId: "tool-1",
			toolName: "Bash",
		});
		expect(manager.store.getSummary("task-codex-new-turn")?.outstandingInteraction?.status).toBe("waiting");

		await ingest("activity", {
			hookEventName: "PreToolUse",
			turnId: "turn-2",
			toolUseId: "tool-2",
			toolName: "Read",
		});
		expect(manager.store.getSummary("task-codex-new-turn")).toMatchObject({
			state: "running",
			reviewReason: null,
			outstandingInteraction: null,
		});
	});

	it("lets a current root Stop retire an identity-poor Codex wait", async () => {
		const { manager, ingest } = await createHarness("codex", "task-codex-root-stop");
		await ingest(
			"to_review",
			{
				hookEventName: "PermissionRequest",
				turnId: "turn-1",
				toolName: "Bash",
			},
			{ occurredAt: 100 },
		);

		await ingest("to_review", { hookEventName: "Stop" }, { occurredAt: 200 });
		expect(manager.store.getSummary("task-codex-root-stop")).toMatchObject({
			state: "awaiting_review",
			reviewReason: "hook",
			outstandingInteraction: null,
		});

		await ingest(
			"activity",
			{
				hookEventName: "PreToolUse",
				turnId: "turn-1",
				toolUseId: "delayed-tool",
				toolName: "Read",
			},
			{ occurredAt: 150 },
		);
		expect(manager.store.getSummary("task-codex-root-stop")?.state).toBe("awaiting_review");

		await ingest(
			"activity",
			{
				hookEventName: "PreToolUse",
				turnId: "turn-2",
				toolUseId: "new-tool",
				toolName: "Read",
			},
			{ occurredAt: 300 },
		);
		expect(manager.store.getSummary("task-codex-root-stop")).toMatchObject({
			state: "running",
			reviewReason: null,
		});
	});

	it("converges a provider-approved Codex permission without fabricating a local response", async () => {
		const { manager, ingest } = await createHarness("codex", "task-codex-provider-approve");
		await ingest("activity", {
			hookEventName: "PreToolUse",
			turnId: "turn-1",
			toolUseId: "tool-1",
			toolName: "Bash",
		});
		await ingest("to_review", {
			hookEventName: "PermissionRequest",
			turnId: "turn-1",
			toolName: "Bash",
		});

		expect(manager.store.getSummary("task-codex-provider-approve")?.outstandingInteraction).toMatchObject({
			status: "waiting",
			toolUseId: "tool-1",
			turnId: "turn-1",
		});

		await ingest("to_in_progress", {
			hookEventName: "PostToolUse",
			turnId: "turn-1",
			toolUseId: "tool-other",
			toolName: "Bash",
		});
		expect(manager.store.getSummary("task-codex-provider-approve")?.outstandingInteraction).toMatchObject({
			status: "waiting",
			toolUseId: "tool-1",
		});

		await ingest("to_in_progress", {
			hookEventName: "PostToolUse",
			turnId: "turn-1",
			toolUseId: "tool-1",
			toolName: "Bash",
		});
		expect(manager.store.getSummary("task-codex-provider-approve")).toMatchObject({
			state: "running",
			reviewReason: null,
			outstandingInteraction: null,
		});
	});

	it("correlates a second same-turn Codex permission after cancellation has no completion hook", async () => {
		const { manager, ingest } = await createHarness("codex", "task-codex-cancel-next-permission");
		await ingest("activity", {
			hookEventName: "PreToolUse",
			turnId: "turn-1",
			toolUseId: "tool-1",
			toolName: "Bash",
		});
		await ingest("to_review", {
			hookEventName: "PermissionRequest",
			turnId: "turn-1",
			toolName: "Bash",
		});

		manager.writeInput("task-codex-cancel-next-permission", Buffer.from("\u001b"));
		expect(manager.store.getSummary("task-codex-cancel-next-permission")?.outstandingInteraction).toMatchObject({
			status: "response_submitted",
			responseKind: "cancel",
			toolUseId: "tool-1",
		});

		await ingest("activity", {
			hookEventName: "PreToolUse",
			turnId: "turn-1",
			toolUseId: "tool-2",
			toolName: "Bash",
		});
		expect(manager.store.getSummary("task-codex-cancel-next-permission")).toMatchObject({
			state: "running",
			outstandingInteraction: null,
		});

		await ingest("to_review", {
			hookEventName: "PermissionRequest",
			turnId: "turn-1",
			toolName: "Bash",
		});
		expect(manager.store.getSummary("task-codex-cancel-next-permission")?.outstandingInteraction).toMatchObject({
			status: "waiting",
			toolUseId: "tool-2",
		});

		await ingest("to_in_progress", {
			hookEventName: "PostToolUse",
			turnId: "turn-1",
			toolUseId: "tool-2",
			toolName: "Bash",
		});
		expect(manager.store.getSummary("task-codex-cancel-next-permission")).toMatchObject({
			state: "running",
			reviewReason: null,
			outstandingInteraction: null,
		});
	});

	it("fails closed when parallel Codex tools make an identity-less permission ambiguous", async () => {
		const { manager, ingest } = await createHarness("codex", "task-codex-ambiguous-permission");
		await ingest("activity", {
			hookEventName: "PreToolUse",
			turnId: "turn-1",
			toolUseId: "tool-1",
			toolName: "Bash",
		});
		await ingest("activity", {
			hookEventName: "PreToolUse",
			turnId: "turn-1",
			toolUseId: "tool-2",
			toolName: "Bash",
		});
		await ingest("to_review", {
			hookEventName: "PermissionRequest",
			turnId: "turn-1",
			toolName: "Bash",
		});

		expect(manager.store.getSummary("task-codex-ambiguous-permission")?.outstandingInteraction).toMatchObject({
			status: "waiting",
			toolUseId: null,
			requestEventName: "PermissionRequest",
		});

		manager.writeInput("task-codex-ambiguous-permission", Buffer.from("y"));
		await ingest("to_in_progress", {
			hookEventName: "PostToolUse",
			turnId: "turn-1",
			toolUseId: "tool-1",
			toolName: "Bash",
		});
		expect(manager.store.getSummary("task-codex-ambiguous-permission")?.outstandingInteraction).toMatchObject({
			status: "response_submitted",
			toolUseId: null,
		});

		await ingest("to_in_progress", {
			hookEventName: "PostToolUse",
			turnId: "turn-1",
			toolUseId: "tool-2",
			toolName: "Bash",
		});
		expect(manager.store.getSummary("task-codex-ambiguous-permission")?.outstandingInteraction).toMatchObject({
			status: "response_submitted",
			toolUseId: null,
		});
	});

	it("records an unrelated Claude completion so its delayed permission cannot replace the active wait", async () => {
		const { manager, ingest } = await createHarness("claude", "task-claude-delayed-permission");
		await ingest(
			"activity",
			{
				hookEventName: "PreToolUse",
				promptId: "prompt-1",
				toolUseId: "tool-1",
				toolName: "Bash",
			},
			{ occurredAt: 100 },
		);
		await ingest(
			"to_review",
			{
				hookEventName: "PermissionRequest",
				promptId: "prompt-1",
				toolName: "Bash",
			},
			{ occurredAt: 110 },
		);

		await ingest(
			"to_in_progress",
			{
				hookEventName: "PostToolUse",
				promptId: "prompt-1",
				toolUseId: "tool-2",
				toolName: "Read",
			},
			{ occurredAt: 200 },
		);
		expect(manager.store.getSummary("task-claude-delayed-permission")?.outstandingInteraction).toMatchObject({
			status: "waiting",
			toolUseId: "tool-1",
			toolName: "Bash",
		});

		await ingest(
			"to_review",
			{
				hookEventName: "PermissionRequest",
				promptId: "prompt-1",
				toolName: "Read",
			},
			{ occurredAt: 150 },
		);
		expect(manager.store.getSummary("task-claude-delayed-permission")?.outstandingInteraction).toMatchObject({
			status: "waiting",
			toolUseId: "tool-1",
			toolName: "Bash",
		});
	});

	it("keeps Codex cancellation pending until a scoped Stop proves the turn ended", async () => {
		const { manager, ingest } = await createHarness("codex", "task-codex-cancel");
		await ingest(
			"to_review",
			{
				hookEventName: "PermissionRequest",
				turnId: "turn-1",
				toolUseId: "tool-1",
				toolName: "Bash",
			},
			{ occurredAt: 200 },
		);

		manager.writeInput("task-codex-cancel", Buffer.from([0x1b]));
		expect(manager.store.getSummary("task-codex-cancel")?.outstandingInteraction).toMatchObject({
			status: "response_submitted",
			responseKind: "cancel",
		});

		await ingest("to_review", { hookEventName: "Stop", turnId: "turn-old" }, { occurredAt: 150 });
		expect(manager.store.getSummary("task-codex-cancel")?.outstandingInteraction).not.toBeNull();

		await ingest("to_review", { hookEventName: "Stop", turnId: "turn-1" });
		expect(manager.store.getSummary("task-codex-cancel")).toMatchObject({
			state: "awaiting_review",
			reviewReason: "hook",
			outstandingInteraction: null,
		});
	});
});
