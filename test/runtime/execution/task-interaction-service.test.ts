import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { TaskResourceOperationCoordinator } from "../../../src/core";
import type {
	CodexPendingInteraction,
	CodexStructuredOwnerRegistry,
	CodexTurn,
	TaskExecutionOwnership,
	TaskExecutionOwnershipService,
} from "../../../src/execution";
import { TaskInteractionService } from "../../../src/execution";
import { ProjectExecutionOwnershipStore } from "../../../src/state";
import { createTempDir } from "../../utilities/temp-dir";

const originalStateHome = process.env.QUARTERDECK_STATE_HOME;
let cleanup = () => {};

beforeEach(() => {
	const temp = createTempDir("quarterdeck-task-interactions-");
	cleanup = temp.cleanup;
	process.env.QUARTERDECK_STATE_HOME = temp.path;
});

afterEach(() => {
	cleanup();
	if (originalStateHome === undefined) delete process.env.QUARTERDECK_STATE_HOME;
	else process.env.QUARTERDECK_STATE_HOME = originalStateHome;
});

function ownership(ownerGeneration = 2): TaskExecutionOwnership {
	return {
		projectId: "project-1",
		taskId: "task-1",
		provider: "codex",
		providerSessionId: "synthetic-session",
		providerSessionTreeId: "synthetic-session",
		providerProfileFingerprint: "a".repeat(64),
		configurationFingerprint: "b".repeat(64),
		providerVersion: "0.149.1",
		protocolSchemaFingerprint: "c".repeat(64),
		historyMode: "paginated",
		state: "structured",
		ownerGeneration,
		ownerSessionInstanceId: `owner-${ownerGeneration}`,
		ownerProcess: {
			processKind: "stdio_app_server",
			pid: 123,
			sessionInstanceId: `owner-${ownerGeneration}`,
			launchOperationId: "handoff-1",
		},
		activeTurn: null,
		pendingHandoff: null,
		lastFailure: null,
		updatedAt: 100,
	};
}

function completedTurn(): CodexTurn {
	return {
		id: "turn-1",
		status: "completed",
		startedAt: 1,
		completedAt: 2,
		durationMs: 1,
		error: null,
		items: [],
		itemsView: "summary",
	};
}

function questionInteraction(): CodexPendingInteraction {
	return {
		interactionId: "client-1:77",
		method: "item/tool/requestUserInput",
		threadId: "synthetic-session",
		turnId: "turn-1",
		itemId: "item-1",
		kind: "question",
		questionIds: ["question-1"],
		allowedApprovalDecisions: null,
		promptText: "Synthetic question?",
		optionLabels: ["Option A", "Option B"],
		createdAt: 100,
	};
}

describe.sequential("TaskInteractionService", () => {
	it("projects only pending attention owned by the exact live structured session", async () => {
		const getOwnership = vi.fn(async () => ownership());
		const getOwner = vi.fn(() => ({
			context: { ownerGeneration: 2, ownerSessionInstanceId: "owner-2" },
			hasWriteAuthority: () => true,
			listPendingInteractions: () => [questionInteraction()],
		}));
		const service = new TaskInteractionService({
			store: new ProjectExecutionOwnershipStore(),
			ownership: { getOwnership } as unknown as TaskExecutionOwnershipService,
			structuredOwners: { get: getOwner } as unknown as CodexStructuredOwnerRegistry,
			taskResourceOperations: new TaskResourceOperationCoordinator(),
		});
		const scope = { projectId: "project-1", projectPath: "/synthetic/project" };

		await expect(service.listPendingAttention(scope, "task-1")).resolves.toEqual([
			{
				id: "client-1:77",
				kind: "question",
				sessionInstanceId: "owner-2",
				createdAt: 100,
				promptText: "Synthetic question?",
				options: ["Option A", "Option B"],
			},
		]);

		getOwner.mockReturnValueOnce({
			context: { ownerGeneration: 3, ownerSessionInstanceId: "owner-3" },
			hasWriteAuthority: () => true,
			listPendingInteractions: () => [questionInteraction()],
		});
		await expect(service.listPendingAttention(scope, "task-1")).resolves.toEqual([]);
	});

	it("rejects control sequences and oversized text before touching the owner", async () => {
		const getOwnership = vi.fn(async () => ownership());
		const service = new TaskInteractionService({
			store: new ProjectExecutionOwnershipStore(),
			ownership: { getOwnership } as unknown as TaskExecutionOwnershipService,
			structuredOwners: { get: vi.fn() } as unknown as CodexStructuredOwnerRegistry,
			taskResourceOperations: new TaskResourceOperationCoordinator(),
		});
		const scope = { projectId: "project-1", projectPath: "/synthetic/project" };

		await expect(
			service.execute(scope, {
				kind: "send_message",
				operationId: "message-control",
				taskId: "task-1",
				expectedOwnerGeneration: 2,
				text: "synthetic\u001b[31m",
			}),
		).resolves.toEqual({ ok: false, outcome: "invalid_request", replayed: false });
		await expect(
			service.execute(scope, {
				kind: "send_message",
				operationId: "message-oversized",
				taskId: "task-1",
				expectedOwnerGeneration: 2,
				text: "x".repeat(64 * 1024 + 1),
			}),
		).resolves.toEqual({ ok: false, outcome: "invalid_request", replayed: false });
		expect(getOwnership).not.toHaveBeenCalled();
	});

	it("does not redispatch a pending message and permits its addressed question to be answered", async () => {
		const store = new ProjectExecutionOwnershipStore();
		const scope = { projectId: "project-1", projectPath: "/synthetic/project" };
		let finishTurn: (turn: CodexTurn) => void = () => {
			throw new Error("Turn completion was not initialized.");
		};
		const completion = new Promise<CodexTurn>((resolve) => {
			finishTurn = resolve;
		});
		const startMessage = vi.fn(async () => ({
			turn: { ...completedTurn(), status: "inProgress" as const },
			completion,
		}));
		const answerInteraction = vi.fn(() => "completed" as const);
		let activeTurnId: string | null = null;
		const owner = {
			context: { ownerGeneration: 2 },
			getActiveTurnId: () => activeTurnId,
			hasActiveTurn: () => activeTurnId !== null,
			hasWriteAuthority: () => true,
			startMessage: vi.fn(async (...input: Parameters<typeof startMessage>) => {
				activeTurnId = "turn-1";
				return await startMessage(...input);
			}),
			listPendingInteractions: () => [questionInteraction()],
			answerInteraction,
		};
		const ownershipService = {
			getOwnership: async () => ownership(),
			stopCurrentOwner: vi.fn(),
		} as unknown as TaskExecutionOwnershipService;
		const registry = { get: () => owner } as unknown as CodexStructuredOwnerRegistry;
		const service = new TaskInteractionService({
			store,
			ownership: ownershipService,
			structuredOwners: registry,
			taskResourceOperations: new TaskResourceOperationCoordinator(),
		});
		const message = {
			kind: "send_message" as const,
			operationId: "message-1",
			taskId: "task-1",
			expectedOwnerGeneration: 2,
			text: "synthetic message",
		};
		const first = service.execute(scope, message);
		await vi.waitFor(() => expect(startMessage).toHaveBeenCalledTimes(1));

		await expect(service.execute(scope, message)).resolves.toEqual({
			ok: false,
			outcome: "turn_outcome_unknown",
			replayed: true,
		});
		expect(startMessage).toHaveBeenCalledTimes(1);

		await expect(
			service.execute(scope, {
				kind: "answer_prompt",
				operationId: "answer-1",
				taskId: "task-1",
				expectedOwnerGeneration: 2,
				interactionId: "client-1:77",
				answer: { type: "question", answers: { "question-1": ["synthetic answer"] } },
			}),
		).resolves.toEqual({ ok: true, outcome: "completed", replayed: false });
		expect(answerInteraction).toHaveBeenCalledWith("client-1:77", {
			type: "question",
			answers: { "question-1": ["synthetic answer"] },
		});

		finishTurn(completedTurn());
		await expect(first).resolves.toEqual({
			ok: true,
			outcome: "completed",
			replayed: false,
			turnId: "turn-1",
		});
	});

	it("revalidates the owner generation after entering the task resource lock", async () => {
		let reads = 0;
		const startMessage = vi.fn();
		const service = new TaskInteractionService({
			store: new ProjectExecutionOwnershipStore(),
			ownership: {
				getOwnership: async () => ownership(reads++ === 0 ? 2 : 3),
			} as unknown as TaskExecutionOwnershipService,
			structuredOwners: {
				get: () => ({
					context: { ownerGeneration: 2 },
					getActiveTurnId: () => null,
					hasActiveTurn: () => false,
					hasWriteAuthority: () => true,
					startMessage,
				}),
			} as unknown as CodexStructuredOwnerRegistry,
			taskResourceOperations: new TaskResourceOperationCoordinator(),
		});
		await expect(
			service.execute(
				{ projectId: "project-1", projectPath: "/synthetic/project" },
				{
					kind: "send_message",
					operationId: "message-stale",
					taskId: "task-1",
					expectedOwnerGeneration: 2,
					text: "synthetic message",
				},
			),
		).resolves.toEqual({ ok: false, outcome: "owner_not_structured", replayed: false });
		expect(startMessage).not.toHaveBeenCalled();
	});

	it("preserves approval identity when the addressed owner disappears", async () => {
		let reads = 0;
		const service = new TaskInteractionService({
			store: new ProjectExecutionOwnershipStore(),
			ownership: {
				getOwnership: async () => (reads++ === 0 ? ownership() : null),
			} as unknown as TaskExecutionOwnershipService,
			structuredOwners: { get: () => null } as unknown as CodexStructuredOwnerRegistry,
			taskResourceOperations: new TaskResourceOperationCoordinator(),
		});

		await expect(
			service.execute(
				{ projectId: "project-1", projectPath: "/synthetic/project" },
				{
					kind: "answer_prompt",
					operationId: "approval-stale",
					taskId: "task-1",
					expectedOwnerGeneration: 2,
					interactionId: "approval-1",
					answer: { type: "approval", decision: "decline" },
				},
			),
		).resolves.toEqual({ ok: false, outcome: "approval_not_found", replayed: false });
	});

	it("does not stop a replacement owner after the addressed generation changes", async () => {
		let reads = 0;
		const stopCurrentOwner = vi.fn();
		const service = new TaskInteractionService({
			store: new ProjectExecutionOwnershipStore(),
			ownership: {
				getOwnership: async () => ownership(reads++ === 0 ? 2 : 3),
				stopCurrentOwner,
			} as unknown as TaskExecutionOwnershipService,
			structuredOwners: { get: vi.fn() } as unknown as CodexStructuredOwnerRegistry,
			taskResourceOperations: new TaskResourceOperationCoordinator(),
		});

		await expect(
			service.execute(
				{ projectId: "project-1", projectPath: "/synthetic/project" },
				{
					kind: "stop_task",
					operationId: "stop-stale",
					taskId: "task-1",
					expectedOwnerGeneration: 2,
				},
			),
		).resolves.toEqual({ ok: false, outcome: "owner_not_structured", replayed: false });
		expect(stopCurrentOwner).not.toHaveBeenCalled();
	});

	it("classifies any ambiguous message dispatch failure as outcome unknown", async () => {
		const startMessage = vi.fn(async () => {
			throw new Error("synthetic protocol ambiguity");
		});
		const store = new ProjectExecutionOwnershipStore();
		const service = new TaskInteractionService({
			store,
			ownership: { getOwnership: async () => ownership() } as unknown as TaskExecutionOwnershipService,
			structuredOwners: {
				get: () => ({
					context: { ownerGeneration: 2 },
					getActiveTurnId: () => null,
					hasActiveTurn: () => false,
					hasWriteAuthority: () => true,
					startMessage,
				}),
			} as unknown as CodexStructuredOwnerRegistry,
			taskResourceOperations: new TaskResourceOperationCoordinator(),
		});
		const scope = { projectId: "project-1", projectPath: "/synthetic/project" };
		const command = {
			kind: "send_message" as const,
			operationId: "message-ambiguous",
			taskId: "task-1",
			expectedOwnerGeneration: 2,
			text: "synthetic message",
		};

		await expect(service.execute(scope, command)).resolves.toEqual({
			ok: false,
			outcome: "turn_outcome_unknown",
			replayed: false,
		});
		await expect(service.execute(scope, command)).resolves.toEqual({
			ok: false,
			outcome: "turn_outcome_unknown",
			replayed: true,
		});
		expect(startMessage).toHaveBeenCalledTimes(1);
	});

	it("records a provider-confirmed interrupted turn without treating it as completed", async () => {
		const interrupted = { ...completedTurn(), status: "interrupted" as const };
		const service = new TaskInteractionService({
			store: new ProjectExecutionOwnershipStore(),
			ownership: { getOwnership: async () => ownership() } as unknown as TaskExecutionOwnershipService,
			structuredOwners: {
				get: () => ({
					context: { ownerGeneration: 2 },
					getActiveTurnId: () => null,
					hasActiveTurn: () => false,
					hasWriteAuthority: () => true,
					startMessage: async () => ({ turn: interrupted, completion: Promise.resolve(interrupted) }),
				}),
			} as unknown as CodexStructuredOwnerRegistry,
			taskResourceOperations: new TaskResourceOperationCoordinator(),
		});

		await expect(
			service.execute(
				{ projectId: "project-1", projectPath: "/synthetic/project" },
				{
					kind: "send_message",
					operationId: "message-interrupted",
					taskId: "task-1",
					expectedOwnerGeneration: 2,
					text: "synthetic message",
				},
			),
		).resolves.toEqual({
			ok: false,
			outcome: "interrupted",
			replayed: false,
			turnId: "turn-1",
		});
	});

	it("preserves a provider owner's fail-closed approval decision", async () => {
		const answerInteraction = vi.fn(() => "unsupported_interaction" as const);
		const service = new TaskInteractionService({
			store: new ProjectExecutionOwnershipStore(),
			ownership: { getOwnership: async () => ownership() } as unknown as TaskExecutionOwnershipService,
			structuredOwners: {
				get: () => ({
					context: { ownerGeneration: 2 },
					hasWriteAuthority: () => true,
					answerInteraction,
				}),
			} as unknown as CodexStructuredOwnerRegistry,
			taskResourceOperations: new TaskResourceOperationCoordinator(),
		});
		await expect(
			service.execute(
				{ projectId: "project-1", projectPath: "/synthetic/project" },
				{
					kind: "answer_prompt",
					operationId: "approval-1",
					taskId: "task-1",
					expectedOwnerGeneration: 2,
					interactionId: "client-1:77",
					answer: { type: "approval", decision: "accept" },
				},
			),
		).resolves.toEqual({ ok: false, outcome: "unsupported_interaction", replayed: false });
		expect(answerInteraction).toHaveBeenCalledWith("client-1:77", {
			type: "approval",
			decision: "accept",
		});
	});
});
