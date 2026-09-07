import { execFile } from "node:child_process";
import { stat } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { expect, it, vi } from "vitest";
import { TaskResourceOperationCoordinator } from "../../src/core";
import { createNativeTerminalInputWriter } from "../../src/execution/native-terminal-input";
import { ProjectExecutionOwnershipStore } from "../../src/state";
import { getProjectExecutionOwnershipPath } from "../../src/state/project-state-utils";
import { createTestTaskSessionSummary } from "../utilities/task-session-factory";
import { createTempDir } from "../utilities/temp-dir";

const execFileAsync = promisify(execFile);
const repositoryRoot = fileURLToPath(new URL("../../", import.meta.url));

it("rejects warmed native input after another process commits structured ownership", async () => {
	const temp = createTempDir("quarterdeck-cross-process-input-");
	const previousStateHome = process.env.QUARTERDECK_STATE_HOME;
	process.env.QUARTERDECK_STATE_HOME = temp.path;
	const scope = { projectId: "input-project", projectPath: repositoryRoot };
	const store = new ProjectExecutionOwnershipStore();
	const manager = {
		getTaskSessionProcessIdentity: () => ({
			pid: 123,
			sessionInstanceId: "native-a",
			launchOperationId: null,
			agentId: "codex" as const,
			binary: null,
			profileEnvironment: {},
		}),
		writeInput: vi.fn(() => createTestTaskSessionSummary({ taskId: "task" })),
	};
	const writer = createNativeTerminalInputWriter({
		scope,
		taskId: "task",
		manager,
		authorization: store.createNativeInputAuthorization(scope, "task"),
		taskResourceOperations: new TaskResourceOperationCoordinator(),
		hasStructuredOwner: () => false,
	});
	try {
		await store.putOwnership(scope, {
			projectId: scope.projectId,
			taskId: "task",
			provider: "codex",
			providerSessionId: "provider-a",
			providerSessionTreeId: null,
			providerProfileFingerprint: "a".repeat(64),
			configurationFingerprint: null,
			providerVersion: "test",
			protocolSchemaFingerprint: "b".repeat(64),
			historyMode: null,
			state: "native_tui",
			ownerGeneration: 0,
			ownerSessionInstanceId: "native-a",
			ownerProcess: null,
			activeTurn: null,
			pendingHandoff: null,
			lastFailure: null,
			updatedAt: 1,
		});
		await writer.write(Buffer.from("before"));
		expect(manager.writeInput).toHaveBeenCalledTimes(1);
		const originalSize = (await stat(getProjectExecutionOwnershipPath(scope.projectId))).size;
		await execFileAsync(
			process.execPath,
			[
				"--import",
				"tsx",
				"--input-type=module",
				"--eval",
				`
   import { ProjectExecutionOwnershipStore } from './src/state/project-execution-ownership-store.ts';
   const scope = { projectId: 'input-project', projectPath: process.cwd() };
   const store = new ProjectExecutionOwnershipStore();
   const owner = await store.getOwnership(scope, 'task');
   if (!owner) throw new Error('Missing synthetic owner');
   await store.putOwnership(scope, { ...owner, state: 'structured', ownerGeneration: 1,
    ownerSessionInstanceId: 'struct-b', updatedAt: 2 });
  `,
			],
			{ cwd: repositoryRoot, env: { ...process.env }, timeout: 10000 },
		);
		expect((await stat(getProjectExecutionOwnershipPath(scope.projectId))).size).toBe(originalSize);
		// Do not refresh through this store: a live input connection must discover
		// external authority without waiting for the periodic reconciliation loop.
		await expect(writer.write(Buffer.from("after"))).rejects.toThrow("structured");
		expect(manager.writeInput).toHaveBeenCalledTimes(1);
	} finally {
		writer.dispose();
		if (previousStateHome === undefined) delete process.env.QUARTERDECK_STATE_HOME;
		else process.env.QUARTERDECK_STATE_HOME = previousStateHome;
		temp.cleanup();
	}
});
