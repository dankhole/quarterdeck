import { readFile, stat } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const ptySessionSpawnMock = vi.hoisted(() => vi.fn());
vi.mock("../../../src/terminal/pty-session.js", () => ({ PtySession: { spawn: ptySessionSpawnMock } }));

import { InMemorySessionSummaryStore, TerminalSessionManager } from "../../../src/terminal";
import * as agentAdapters from "../../../src/terminal/agent-session-adapters";
import { spawnTaskSession } from "../../../src/terminal/session-lifecycle";
import { createProcessEntry, type StartTaskSessionRequest } from "../../../src/terminal/session-manager-types";

interface MockSpawnRequest {
	args: string[];
	onExit: (event: { exitCode: number | null }) => void;
}

const prompt = "Reference material: λ\n".repeat(100_000);
const request: StartTaskSessionRequest = {
	taskId: "large-prompt",
	agentId: "pi",
	binary: "pi",
	args: [],
	cwd: process.cwd(),
	prompt,
};

function promptPath(args: string[]): string {
	const argument = args.find((arg) => arg.startsWith("@"));
	if (!argument) throw new Error("Expected a file-backed Pi prompt");
	return fileURLToPath(argument.slice(1));
}

async function expectRemoved(path: string): Promise<void> {
	await vi.waitFor(async () => {
		await expect(stat(path)).rejects.toMatchObject({ code: "ENOENT" });
	});
}

describe("task prompt file lifecycle", () => {
	const managers: TerminalSessionManager[] = [];
	let launches: MockSpawnRequest[];
	let registerOwnership: () => Promise<void>;
	let exitOnStop: boolean;
	let exitBeforeHandoff: boolean;

	beforeEach(() => {
		launches = [];
		exitOnStop = true;
		exitBeforeHandoff = false;
		registerOwnership = async () => {};
		ptySessionSpawnMock.mockReset();
		ptySessionSpawnMock.mockImplementation((launch: MockSpawnRequest) => {
			launches.push(launch);
			let interrupted = false;
			const session = {
				pid: 101 + launches.length,
				registerManagedProcessOwnership: () => registerOwnership(),
				write: vi.fn(),
				resize: vi.fn(),
				pause: vi.fn(),
				resume: vi.fn(),
				stop: vi.fn((options?: { interrupted?: boolean }) => {
					interrupted = options?.interrupted ?? false;
					if (exitOnStop) launch.onExit({ exitCode: 0 });
				}),
				wasInterrupted: () => interrupted,
			};
			if (exitBeforeHandoff) launch.onExit({ exitCode: 0 });
			return session;
		});
	});

	afterEach(() => {
		for (const manager of managers.splice(0)) manager.markInterruptedAndStopAll();
	});

	function manager(): TerminalSessionManager {
		const instance = new TerminalSessionManager(new InMemorySessionSummaryStore());
		managers.push(instance);
		return instance;
	}

	it("keeps the full prompt available after spawn and removes it on natural exit", async () => {
		const instance = manager();
		await instance.startTaskSession(request);
		const launch = launches[0];
		if (!launch) throw new Error("Expected launch");
		const path = promptPath(launch.args);
		expect(await readFile(path, "utf8")).toBe(`\uFEFF${prompt.trim()}`);
		expect(launch.args).not.toContain(prompt.trim());
		launch.onExit({ exitCode: 0 });
		await expectRemoved(path);
	});

	it.each(["stop", "shutdown"] as const)("removes the prompt file after %s", async (action) => {
		const instance = manager();
		await instance.startTaskSession(request);
		const launch = launches[0];
		if (!launch) throw new Error("Expected launch");
		const path = promptPath(launch.args);
		if (action === "stop") instance.stopTaskSession(request.taskId);
		else instance.markInterruptedAndStopAll();
		await expectRemoved(path);
	});

	it.each(["stop", "failed resume"] as const)(
		"keeps the prompt available after %s is signalled until the exact process exits",
		async (action) => {
			exitOnStop = false;
			const instance = manager();
			const summary = await instance.startTaskSession({
				...request,
				...(action === "failed resume" ? { resumeConversation: true, resumeSessionId: "expected-session" } : {}),
			});
			const launch = launches[0];
			if (!launch || !summary.sessionInstanceId) throw new Error("Expected active launch");
			const path = promptPath(launch.args);
			if (action === "stop") instance.stopTaskSession(request.taskId);
			else {
				expect(
					instance.observeTaskSessionLaunchHook(request.taskId, {
						source: "pi",
						sessionInstanceId: summary.sessionInstanceId,
						sessionId: "wrong-session",
					}),
				).toBe(false);
			}
			expect(await readFile(path, "utf8")).toBe(`\uFEFF${prompt.trim()}`);
			launch.onExit({ exitCode: 0 });
			await expectRemoved(path);
		},
	);

	it("removes a failed launch's file before reporting the spawn failure", async () => {
		const instance = manager();
		let path: string | undefined;
		ptySessionSpawnMock.mockImplementation((launch: MockSpawnRequest) => {
			path = promptPath(launch.args);
			throw new Error("synthetic spawn failure");
		});
		await expect(instance.startTaskSession(request)).rejects.toThrow("Failed to launch task terminal");
		if (!path) throw new Error("Expected file-backed failed launch");
		await expect(stat(path)).rejects.toMatchObject({ code: "ENOENT" });
		expect(instance.store.getSummary(request.taskId)).toMatchObject({
			pid: null,
			reviewReason: "error",
		});
	});

	it("removes a prompt if process-ownership registration fails after spawn", async () => {
		const instance = manager();
		registerOwnership = async () => {
			throw new Error("synthetic process-custody failure");
		};
		await expect(instance.startTaskSession(request)).rejects.toThrow("Failed to launch task terminal");
		const launch = launches[0];
		if (!launch) throw new Error("Expected launch before ownership failure");
		await expect(stat(promptPath(launch.args))).rejects.toMatchObject({ code: "ENOENT" });
		expect(instance.store.getSummary(request.taskId)).toMatchObject({ pid: null, reviewReason: "error" });
	});

	it("cleans a prepared prompt when launch admission is cancelled", async () => {
		const store = new InMemorySessionSummaryStore();
		const prepare = agentAdapters.prepareAgentLaunch;
		let path: string | undefined;
		const spy = vi.spyOn(agentAdapters, "prepareAgentLaunch").mockImplementation(async (input) => {
			const launch = await prepare(input);
			path = promptPath(launch.args);
			return launch;
		});
		try {
			await expect(
				spawnTaskSession(createProcessEntry(request.taskId), request, {
					getSummary: (id) => store.getSummary(id),
					updateStore: (id, patch) => store.update(id, patch),
					ensureEntry: (id) => store.ensureEntry(id),
					onOutput: vi.fn(),
					onExit: vi.fn(),
					isLaunchAllowed: () => false,
				}),
			).rejects.toThrow("cancelled");
			expect(ptySessionSpawnMock).not.toHaveBeenCalled();
			if (!path) throw new Error("Expected prepared prompt file");
			await expect(stat(path)).rejects.toMatchObject({ code: "ENOENT" });
		} finally {
			spy.mockRestore();
		}
	});

	it("cleans an early-exited launch whose ownership was retired during summary publication", async () => {
		exitBeforeHandoff = true;
		const store = new InMemorySessionSummaryStore();
		const entry = createProcessEntry(request.taskId);
		const onExit = vi.fn();
		await spawnTaskSession(entry, request, {
			getSummary: (id) => store.getSummary(id),
			updateStore: (id, patch) => {
				// Simulate synchronous publication retiring the just-created entry.
				entry.active = null;
				return store.update(id, patch);
			},
			ensureEntry: (id) => store.ensureEntry(id),
			onOutput: vi.fn(),
			onExit,
			isLaunchAllowed: () => true,
		});
		const launch = launches[0];
		if (!launch) throw new Error("Expected early-exited launch");
		await expect(stat(promptPath(launch.args))).rejects.toMatchObject({ code: "ENOENT" });
		expect(onExit).not.toHaveBeenCalled();
	});

	it("cleans a stale active process's prompt before replacing its session", async () => {
		const instance = manager();
		await instance.startTaskSession(request);
		const first = launches[0];
		if (!first) throw new Error("Expected first launch");
		const path = promptPath(first.args);
		instance.store.update(request.taskId, { state: "idle", reviewReason: null });
		await instance.startTaskSession(request);
		await expectRemoved(path);
		expect(launches).toHaveLength(2);
	});

	it("cleans a replaced launch only when that old process exits without touching the replacement", async () => {
		exitOnStop = false;
		const instance = manager();
		await instance.startTaskSession(request);
		const first = launches[0];
		if (!first) throw new Error("Expected first launch");
		const firstPath = promptPath(first.args);
		instance.store.update(request.taskId, { state: "idle", reviewReason: null });
		const replacement = await instance.startTaskSession(request);
		const second = launches[1];
		if (!second) throw new Error("Expected replacement launch");
		const secondPath = promptPath(second.args);
		expect(await readFile(firstPath, "utf8")).toBe(`\uFEFF${prompt.trim()}`);
		first.onExit({ exitCode: 0 });
		await expectRemoved(firstPath);
		expect(await readFile(secondPath, "utf8")).toBe(`\uFEFF${prompt.trim()}`);
		expect(instance.store.getSummary(request.taskId)?.sessionInstanceId).toBe(replacement.sessionInstanceId);
		second.onExit({ exitCode: 0 });
		await expectRemoved(secondPath);
	});

	it("creates a fresh prompt file for a later exact resume", async () => {
		const instance = manager();
		await instance.startTaskSession(request);
		const first = launches[0];
		if (!first) throw new Error("Expected first launch");
		const firstPath = promptPath(first.args);
		first.onExit({ exitCode: 0 });
		await expectRemoved(firstPath);
		await instance.startTaskSession({ ...request, resumeConversation: true, resumeSessionId: "saved-session" });
		const second = launches[1];
		if (!second) throw new Error("Expected resume launch");
		expect(second.args).toContain("--session");
		expect(second.args).toContain("saved-session");
		const secondPath = promptPath(second.args);
		expect(secondPath).not.toBe(firstPath);
		expect(await readFile(secondPath, "utf8")).toBe(`\uFEFF${prompt.trim()}`);
	});
});
