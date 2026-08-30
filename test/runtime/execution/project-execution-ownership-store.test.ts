import { access, readdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { TaskExecutionOwnership } from "../../../src/execution";
import {
	ExecutionOperationIdentityConflictError,
	ExecutionOwnershipJournalCorruptionError,
	ProjectExecutionOwnershipStore,
} from "../../../src/state";
import { getProjectExecutionOwnershipPath } from "../../../src/state/project-state-utils";
import { createTempDir } from "../../utilities/temp-dir";

const originalStateHome = process.env.QUARTERDECK_STATE_HOME;
let cleanup = () => {};

function ownership(): TaskExecutionOwnership {
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
		ownerGeneration: 2,
		ownerSessionInstanceId: "owner-2",
		ownerProcess: {
			processKind: "stdio_app_server",
			pid: 123,
			sessionInstanceId: "owner-2",
			launchOperationId: "handoff-1",
		},
		activeTurn: null,
		pendingHandoff: null,
		lastFailure: null,
		updatedAt: 100,
	};
}

beforeEach(() => {
	const temp = createTempDir("quarterdeck-execution-store-");
	cleanup = temp.cleanup;
	process.env.QUARTERDECK_STATE_HOME = temp.path;
});

afterEach(() => {
	cleanup();
	if (originalStateHome === undefined) delete process.env.QUARTERDECK_STATE_HOME;
	else process.env.QUARTERDECK_STATE_HOME = originalStateHome;
});

describe.sequential("ProjectExecutionOwnershipStore", () => {
	it("persists exact ownership identity and rejects operation-id content changes", async () => {
		const store = new ProjectExecutionOwnershipStore();
		const scope = { projectId: "project-1", projectPath: "/synthetic/project" };
		await store.putOwnership(scope, ownership());
		const first = await store.beginHandoff(scope, {
			operationId: "handoff-2",
			taskId: "task-1",
			targetOwner: "native_tui",
			expectedOwnerGeneration: 2,
		});
		expect(first.replayed).toBe(false);
		await expect(store.getOwnership(scope, "task-1")).resolves.toMatchObject({
			state: "handoff_to_native_pending",
			pendingHandoff: {
				operationId: "handoff-2",
				targetOwner: "native_tui",
				phase: "recorded",
			},
		});
		const replay = await store.beginHandoff(scope, {
			operationId: "handoff-2",
			taskId: "task-1",
			targetOwner: "native_tui",
			expectedOwnerGeneration: 2,
		});
		expect(replay.replayed).toBe(true);
		await expect(
			store.beginHandoff(scope, {
				operationId: "handoff-2",
				taskId: "task-1",
				targetOwner: "structured",
				expectedOwnerGeneration: 2,
			}),
		).rejects.toBeInstanceOf(ExecutionOperationIdentityConflictError);
		const completed = await store.updateOwnershipAndFinishHandoff(
			scope,
			"task-1",
			"handoff-2",
			"completed",
			(current) => ({
				...current,
				state: "native_tui",
				ownerGeneration: 3,
				ownerSessionInstanceId: "native-3",
				ownerProcess: null,
				pendingHandoff: null,
			}),
		);
		expect(completed).toMatchObject({
			ownership: { state: "native_tui", ownerGeneration: 3, pendingHandoff: null },
			operation: { status: "completed", outcome: "completed" },
		});
	});

	it("persists only an interaction fingerprint and treats a pending replay as ambiguous", async () => {
		const store = new ProjectExecutionOwnershipStore();
		const scope = { projectId: "project-1", projectPath: "/synthetic/project" };
		await store.putOwnership(scope, ownership());
		const payloadFingerprint = "d".repeat(64);
		await store.beginInteraction(scope, {
			operationId: "message-1",
			taskId: "task-1",
			kind: "send_message",
			ownerGeneration: 2,
			payloadFingerprint,
		});
		const raw = await readFile(getProjectExecutionOwnershipPath(scope.projectId), "utf8");
		expect(raw).not.toContain(payloadFingerprint);
		expect(raw).not.toContain("private synthetic prompt");
		const replayed = await store.beginInteraction(scope, {
			operationId: "message-1",
			taskId: "task-1",
			kind: "send_message",
			ownerGeneration: 2,
			payloadFingerprint,
		});
		expect(replayed).toMatchObject({ replayed: true, operation: { status: "pending" } });
	});

	it("keeps a corrupt ownership journal fail-closed across repeated reads", async () => {
		const store = new ProjectExecutionOwnershipStore();
		const scope = { projectId: "project-1", projectPath: "/synthetic/project" };
		const journalPath = getProjectExecutionOwnershipPath(scope.projectId);
		await store.putOwnership(scope, ownership());
		await writeFile(journalPath, "{invalid", "utf8");

		let firstError: ExecutionOwnershipJournalCorruptionError | null = null;
		try {
			await store.getOwnership(scope, "task-1");
		} catch (error) {
			if (error instanceof ExecutionOwnershipJournalCorruptionError) firstError = error;
		}

		expect(firstError?.backupPath).not.toBeNull();
		await expect(access(firstError?.backupPath ?? "")).resolves.toBeUndefined();
		await expect(readFile(journalPath, "utf8")).resolves.toBe("{invalid");
		await expect(store.getOwnership(scope, "task-1")).rejects.toBeInstanceOf(
			ExecutionOwnershipJournalCorruptionError,
		);
		const backupNames = (await readdir(dirname(journalPath))).filter((name) =>
			name.startsWith("execution-ownership.json.corrupt-"),
		);
		expect(backupNames).toHaveLength(1);
	});

	it("rejects shape-valid ownership records that cross their project or task scope", async () => {
		const store = new ProjectExecutionOwnershipStore();
		const scope = { projectId: "project-1", projectPath: "/synthetic/project" };
		const journalPath = getProjectExecutionOwnershipPath(scope.projectId);
		await store.putOwnership(scope, ownership());
		const journal = JSON.parse(await readFile(journalPath, "utf8")) as {
			owners: Record<string, TaskExecutionOwnership>;
		};
		const current = journal.owners["task-1"];
		if (!current) throw new Error("Expected synthetic ownership record.");
		journal.owners["task-1"] = { ...current, projectId: "project-2" };
		await writeFile(journalPath, JSON.stringify(journal), "utf8");

		await expect(store.getOwnership(scope, "task-1")).rejects.toBeInstanceOf(
			ExecutionOwnershipJournalCorruptionError,
		);
	});
});
