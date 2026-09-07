import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TaskResourceOperationCoordinator } from "../../../src/core";
import { createNativeTerminalInputWriter } from "../../../src/execution/native-terminal-input";
import { lockedFileSystem } from "../../../src/fs";
import { ProjectExecutionOwnershipStore } from "../../../src/state";
import { getProjectDirectoryLockRequest } from "../../../src/state/project-state-utils";
import type { NativeTaskSessionProcessIdentity } from "../../../src/terminal";
import { createTestTaskSessionSummary } from "../../utilities/task-session-factory";
import { createTempDir } from "../../utilities/temp-dir";

function deferred() {
	let resolve!: () => void;
	const promise = new Promise<void>((done) => {
		resolve = done;
	});
	return { promise, resolve };
}
const scope = { projectId: "input-project", projectPath: "/synthetic/project" };
const originalStateHome = process.env.QUARTERDECK_STATE_HOME;
let cleanup = () => {};
beforeEach(() => {
	const temp = createTempDir("quarterdeck-native-input-");
	cleanup = temp.cleanup;
	process.env.QUARTERDECK_STATE_HOME = temp.path;
});
afterEach(() => {
	cleanup();
	if (originalStateHome === undefined) delete process.env.QUARTERDECK_STATE_HOME;
	else process.env.QUARTERDECK_STATE_HOME = originalStateHome;
});
function fixture() {
	const store = new ProjectExecutionOwnershipStore();
	const operations = new TaskResourceOperationCoordinator();
	let sessionInstanceId: string | null = "pty-1";
	const manager = {
		getTaskSessionProcessIdentity: (): NativeTaskSessionProcessIdentity | null =>
			sessionInstanceId === null
				? null
				: {
						pid: 123,
						sessionInstanceId,
						launchOperationId: null,
						agentId: "codex",
						binary: null,
						profileEnvironment: {},
					},
		writeInput: vi.fn(() => createTestTaskSessionSummary({ taskId: "task" })),
	};
	const authorization = store.createNativeInputAuthorization(scope, "task");
	const hasStructuredOwner = vi.fn(() => false);
	const writer = createNativeTerminalInputWriter({
		scope,
		taskId: "task",
		manager,
		authorization,
		taskResourceOperations: operations,
		hasStructuredOwner,
	});
	return {
		store,
		operations,
		manager,
		authorization,
		writer,
		hasStructuredOwner,
		replace: () => {
			sessionInstanceId = "pty-2";
		},
		setSession: (id: string | null) => {
			sessionInstanceId = id;
		},
	};
}

describe.sequential("native terminal input", () => {
	it("writes an ordered burst while another task holds the project disk lock", async () => {
		const f = fixture();
		const reads = vi.spyOn(f.store, "getOwnership");
		await f.writer.write(Buffer.from("warmup"));
		const acquired = deferred();
		const release = deferred();
		const hold = lockedFileSystem.withLock(getProjectDirectoryLockRequest(scope.projectId), async () => {
			acquired.resolve();
			await release.promise;
		});
		await acquired.promise;
		const timeout = setTimeout(release.resolve, 1000);
		let lockHeld = true;
		void hold.then(() => {
			lockHeld = false;
		});
		try {
			await Promise.all(Array.from({ length: 100 }, (_, index) => f.writer.write(Buffer.from(String(index)))));
			expect(lockHeld).toBe(true);
			expect(reads).toHaveBeenCalledTimes(1);
			expect(f.manager.writeInput.mock.calls.map((call) => call)).toHaveLength(101);
			expect(f.manager.writeInput).toHaveBeenNthCalledWith(101, "task", Buffer.from("99"));
		} finally {
			clearTimeout(timeout);
			release.resolve();
			await hold;
			f.writer.dispose();
		}
	});
	it("binds a pre-launch attachment only to the PTY present when input arrives", async () => {
		const f = fixture();
		f.writer.dispose();
		f.setSession(null);
		const writer = createNativeTerminalInputWriter({
			scope,
			taskId: "task",
			manager: f.manager,
			authorization: f.store.createNativeInputAuthorization(scope, "task"),
			taskResourceOperations: f.operations,
			hasStructuredOwner: f.hasStructuredOwner,
		});
		expect(await writer.write(Buffer.from("before launch"))).toBeNull();
		f.setSession("first");
		expect(await writer.write(Buffer.from("first"))).not.toBeNull();
		f.replace();
		expect(await writer.write(Buffer.from("replacement"))).toBeNull();
		expect(f.manager.writeInput).toHaveBeenCalledTimes(1);
		writer.dispose();
	});
	it.each(["replacement", "disconnect"])("drops queued input after %s", async (reason) => {
		const f = fixture();
		const acquired = deferred();
		const release = deferred();
		const hold = f.operations.run(scope.projectId, "task", async () => {
			acquired.resolve();
			await release.promise;
		});
		await acquired.promise;
		const write = f.writer.write(Buffer.from("old"));
		if (reason === "replacement") f.replace();
		else f.writer.dispose();
		release.resolve();
		await hold;
		expect(await write).toBeNull();
		expect(f.manager.writeInput).not.toHaveBeenCalled();
		f.writer.dispose();
	});
	it("checks structured process ownership immediately before writing", async () => {
		const f = fixture();
		const original = f.authorization.read;
		vi.spyOn(f.authorization, "read").mockImplementationOnce(async () => {
			const observed = await original();
			f.hasStructuredOwner.mockReturnValue(true);
			return observed;
		});
		await expect(f.writer.write(Buffer.from("x"))).rejects.toThrow("structured");
		expect(f.manager.writeInput).not.toHaveBeenCalled();
		f.writer.dispose();
	});
	it("reverifies a snapshot superseded before the writer resumes", async () => {
		const f = fixture();
		const original = f.authorization.read;
		vi.spyOn(f.authorization, "read").mockImplementationOnce(async () => {
			const observed = await original();
			await f.store.putOwnership(scope, {
				projectId: scope.projectId,
				taskId: "task",
				provider: "codex",
				providerSessionId: "synthetic-session",
				providerSessionTreeId: null,
				providerProfileFingerprint: "a".repeat(64),
				configurationFingerprint: null,
				providerVersion: "test",
				protocolSchemaFingerprint: "b".repeat(64),
				historyMode: null,
				state: "structured",
				ownerGeneration: 1,
				ownerSessionInstanceId: "structured-1",
				ownerProcess: null,
				activeTurn: null,
				pendingHandoff: null,
				lastFailure: null,
				updatedAt: 1,
			});
			return observed;
		});
		await expect(f.writer.write(Buffer.from("x"))).rejects.toThrow("structured");
		expect(f.authorization.read).toHaveBeenCalledTimes(2);
		expect(f.manager.writeInput).not.toHaveBeenCalled();
		f.writer.dispose();
	});
	it("fails closed when initial durable verification fails", async () => {
		const f = fixture();
		vi.spyOn(f.store, "getOwnership").mockRejectedValueOnce(new Error("disk unavailable"));
		await expect(f.writer.write(Buffer.from("x"))).rejects.toThrow("disk unavailable");
		expect(f.manager.writeInput).not.toHaveBeenCalled();
		f.writer.dispose();
	});
});
