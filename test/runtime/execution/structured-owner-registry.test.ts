import { describe, expect, it, vi } from "vitest";
import type {
	ClaudeStructuredOwnerRegistry,
	StartStructuredOwnerInput,
	StructuredOwner,
	StructuredOwnerRegistryContract,
} from "../../../src/execution";
import { CodexStructuredOwnerRegistry, StructuredOwnerRegistry } from "../../../src/execution";

function startInput(provider: "codex" | "claude"): StartStructuredOwnerInput {
	return {
		provider,
		projectId: "project-1",
		projectPath: "/synthetic/project",
		taskId: "task-1",
		binary: provider,
		nativeArgs: [],
		cwd: "/synthetic/worktree",
		providerSessionId: "session-1",
		ownerGeneration: 1,
		ownerSessionInstanceId: "owner-1",
		launchOperationId: "handoff-1",
	};
}

function owner(provider: "codex" | "claude"): StructuredOwner {
	return {
		context: {
			provider,
			projectId: "project-1",
			projectPath: "/synthetic/project",
			taskId: "task-1",
			ownerGeneration: 1,
			ownerSessionInstanceId: "owner-1",
		},
		identity: {
			providerSessionId: "session-1",
			providerSessionTreeId: provider === "codex" ? "session-1" : null,
			providerProfileFingerprint: "a".repeat(64),
			configurationFingerprint: "b".repeat(64),
			providerVersion: "synthetic",
			protocolSchemaFingerprint: "c".repeat(64),
			historyMode: provider === "codex" ? "paginated" : null,
			ownerSessionInstanceId: "owner-1",
			pid: 123,
			processKind: provider === "codex" ? "stdio_app_server" : "stdio_agent_sdk",
		},
		hasActiveTurn: () => false,
		getActiveTurnId: () => null,
		getActiveTurn: () => null,
		hasPendingInteractions: () => false,
		listPendingInteractions: () => [],
		hasWriteAuthority: () => true,
		startMessage: async () => {
			throw new Error("not used");
		},
		interruptActiveTurn: async () => null,
		readRecentTurns: async () => [],
		answerInteraction: () => "question_not_found",
		stopAndWait: async () => true,
	};
}

function registry(start: StructuredOwnerRegistryContract["start"]): StructuredOwnerRegistryContract {
	return {
		setEvents: vi.fn(),
		get: () => null,
		start,
		stop: async () => "not_running",
		stopAll: async () => 0,
	};
}

describe("StructuredOwnerRegistry", () => {
	it("serializes concurrent starts across providers for one task", async () => {
		let releaseCodex!: () => void;
		const blockedCodex = new Promise<void>((resolve) => {
			releaseCodex = resolve;
		});
		const codex = registry(async () => {
			await blockedCodex;
			return owner("codex");
		});
		const claudeStart = vi.fn(async () => owner("claude"));
		const combined = new StructuredOwnerRegistry(
			codex as unknown as CodexStructuredOwnerRegistry,
			registry(claudeStart) as unknown as ClaudeStructuredOwnerRegistry,
		);

		const first = combined.start(startInput("codex"));
		await expect(combined.start(startInput("claude"))).rejects.toThrow(
			"A structured owner is already active for this task.",
		);
		expect(claudeStart).not.toHaveBeenCalled();
		releaseCodex();
		await expect(first).resolves.toMatchObject({ context: { provider: "codex" } });
	});

	it("rejects a Claude request at the Codex registry boundary", async () => {
		const codex = new CodexStructuredOwnerRegistry({
			clientVersion: "synthetic",
			resolveProviderVersion: vi.fn(async () => "0.149.1"),
		});
		await expect(codex.start(startInput("claude"))).rejects.toMatchObject({ code: "identity_mismatch" });
	});
});
