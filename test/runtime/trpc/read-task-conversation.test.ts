import { resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { NativeTaskSessionProfileEnvironment, TerminalSessionManager } from "../../../src/terminal";
import { handleReadTaskConversation } from "../../../src/trpc/handlers/read-task-conversation";
import { createTestRuntimeConfigState } from "../../utilities/runtime-config-factory";
import { createTestTaskSessionSummary } from "../../utilities/task-session-factory";

const scope = { projectId: "project-1", projectPath: "/tmp/repo" };
const request = { taskId: "task-1", sessionInstanceId: "launch-1" };
function fixture() {
	const summary = createTestTaskSessionSummary({
		...request,
		agentId: "codex",
		resumeSessionId: "thread-1",
		sessionLaunchPath: "/tmp/worktree",
		pid: 42,
	});
	const identity = {
		pid: 42,
		sessionInstanceId: "launch-1",
		agentId: "codex",
		binary: "codex",
		profileEnvironment: { HOME: "/tmp/home", CODEX_HOME: "profile" } as NativeTaskSessionProfileEnvironment,
	};
	const getSummary = vi.fn(() => summary);
	const getTaskSessionProcessIdentity = vi.fn(() => identity);
	const manager = { store: { getSummary }, getTaskSessionProcessIdentity } as unknown as TerminalSessionManager;
	const exportConversation = vi.fn(async () => "full history");
	const dependencies = {
		config: { loadScopedRuntimeConfig: vi.fn(async () => createTestRuntimeConfigState()) },
		getScopedTerminalManager: vi.fn(async () => manager),
		resolveCommand: vi.fn(async () => ({
			agentId: "codex" as const,
			label: "Codex",
			command: "codex",
			binary: "codex",
			args: [],
		})),
		exportConversation,
	};
	return { summary, identity, getSummary, getTaskSessionProcessIdentity, exportConversation, dependencies };
}

describe("read task conversation", () => {
	it("uses the scoped task's exact thread and launch profile", async () => {
		const f = fixture();
		await expect(handleReadTaskConversation(scope, request, f.dependencies)).resolves.toEqual({
			ok: true,
			text: "full history",
		});
		expect(f.dependencies.getScopedTerminalManager).toHaveBeenCalledWith(scope);
		expect(f.exportConversation).toHaveBeenCalledWith(
			expect.objectContaining({
				threadId: "thread-1",
				codexHome: resolve("/tmp/worktree", "profile"),
				env: expect.objectContaining(f.identity.profileEnvironment),
			}),
		);
	});
	it("rejects a stale browser session before reading", async () => {
		const f = fixture();
		const result = await handleReadTaskConversation(scope, { ...request, sessionInstanceId: "old" }, f.dependencies);
		expect(result.ok).toBe(false);
		expect(f.exportConversation).not.toHaveBeenCalled();
	});
	it.each(["thread", "process"])("discards the response if the %s changes during the read", async (kind) => {
		const f = fixture();
		f.exportConversation.mockImplementation(async () => {
			if (kind === "thread") f.getSummary.mockReturnValue({ ...f.summary, resumeSessionId: "new-thread" });
			else f.getTaskSessionProcessIdentity.mockReturnValue({ ...f.identity, pid: 99 });
			return "stale content";
		});
		await expect(handleReadTaskConversation(scope, request, f.dependencies)).resolves.toEqual({
			ok: false,
			error: expect.stringContaining("changed while copying"),
		});
	});
	it("does not expose raw provider failures or accept a browser-supplied thread", async () => {
		const f = fixture();
		f.exportConversation.mockRejectedValue(new Error("private provider output"));
		const failed = await handleReadTaskConversation(scope, request, f.dependencies);
		expect(failed).toEqual({ ok: false, error: "Could not read the full Codex conversation. Try again." });
		f.exportConversation.mockClear();
		expect((await handleReadTaskConversation(scope, { ...request, threadId: "other" }, f.dependencies)).ok).toBe(
			false,
		);
		expect(f.exportConversation).not.toHaveBeenCalled();
	});
});

describe("read Claude task conversation", () => {
	function claudeFixture() {
		const f = fixture();
		const summary = { ...f.summary, agentId: "claude" as const, resumeSessionId: "claude-session-1" };
		const identity = {
			...f.identity,
			agentId: "claude",
			binary: "claude",
			profileEnvironment: { HOME: "/tmp/home", CLAUDE_CONFIG_DIR: "claude-profile" },
		};
		f.getSummary.mockReturnValue(summary);
		f.getTaskSessionProcessIdentity.mockReturnValue(identity);
		const exportClaudeConversation = vi.fn(async () => "claude history");
		const hint = { providerId: "claude" as const, providerSessionId: "claude-session-1", sourcePath: "/hint.jsonl" };
		const getHint = vi.fn(() => hint);
		return {
			...f,
			summary,
			hint,
			getHint,
			exportClaudeConversation,
			dependencies: { ...f.dependencies, exportClaudeConversation, conversationSourceHints: { getHint } },
		};
	}

	it("reads the exact Claude session from the launch profile without resolving a command", async () => {
		const f = claudeFixture();
		await expect(handleReadTaskConversation(scope, request, f.dependencies)).resolves.toEqual({
			ok: true,
			text: "claude history",
		});
		expect(f.getHint).toHaveBeenCalledWith("project-1", "task-1", "claude-session-1");
		expect(f.exportClaudeConversation).toHaveBeenCalledWith({
			profileRoot: resolve("/tmp/worktree", "claude-profile"),
			sessionId: "claude-session-1",
			hint: f.hint,
		});
		expect(f.dependencies.resolveCommand).not.toHaveBeenCalled();
		expect(f.exportConversation).not.toHaveBeenCalled();
	});

	it("uses Claude wording for stale sessions and unexpected failures", async () => {
		const f = claudeFixture();
		await expect(
			handleReadTaskConversation(scope, { ...request, sessionInstanceId: "old" }, f.dependencies),
		).resolves.toEqual({
			ok: false,
			error: "The Claude session is no longer connected. Open the task and try again.",
		});
		f.exportClaudeConversation.mockRejectedValue(new Error("private path"));
		await expect(handleReadTaskConversation(scope, request, f.dependencies)).resolves.toEqual({
			ok: false,
			error: "Could not read the full Claude conversation. Try again.",
		});
	});

	it("discards the result if the Claude session changes during the read", async () => {
		const f = claudeFixture();
		f.exportClaudeConversation.mockImplementation(async () => {
			f.getSummary.mockReturnValue({ ...f.summary, resumeSessionId: "claude-session-2" });
			return "stale";
		});
		await expect(handleReadTaskConversation(scope, request, f.dependencies)).resolves.toEqual({
			ok: false,
			error: "The Claude conversation changed while copying. Try again.",
		});
	});

	it("rejects unsupported providers", async () => {
		const f = fixture();
		f.getSummary.mockReturnValue({ ...f.summary, agentId: null });
		await expect(handleReadTaskConversation(scope, request, f.dependencies)).resolves.toEqual({
			ok: false,
			error: "Full conversation copying is available for Claude, Codex, and Pi tasks.",
		});
	});
});

describe("read Pi task conversation", () => {
	function piFixture() {
		const f = fixture();
		const summary = { ...f.summary, agentId: "pi" as const, resumeSessionId: "pi-session-1" };
		f.getSummary.mockReturnValue(summary);
		f.getTaskSessionProcessIdentity.mockReturnValue({ ...f.identity, agentId: "pi", binary: "pi" });
		const exportPiConversation = vi.fn(async () => "pi history");
		const hint = {
			providerId: "pi" as const,
			providerSessionId: "pi-session-1",
			sourcePath: "/custom/session.jsonl",
			sessionInstanceId: "launch-1",
		};
		const getHint = vi.fn(() => hint);
		return {
			...f,
			summary,
			hint,
			getHint,
			exportPiConversation,
			dependencies: { ...f.dependencies, exportPiConversation, conversationSourceHints: { getHint } },
		};
	}
	it("reads only the scoped task's exact hook-reported saved file without resolving or launching a provider", async () => {
		const f = piFixture();
		await expect(handleReadTaskConversation(scope, request, f.dependencies)).resolves.toEqual({
			ok: true,
			text: "pi history",
		});
		expect(f.getHint).toHaveBeenCalledWith("project-1", "task-1", "pi-session-1");
		expect(f.exportPiConversation).toHaveBeenCalledWith({
			sessionId: "pi-session-1",
			sessionInstanceId: "launch-1",
			launchPath: "/tmp/worktree",
			hint: f.hint,
		});
		expect(f.dependencies.resolveCommand).not.toHaveBeenCalled();
		expect(f.dependencies.config.loadScopedRuntimeConfig).not.toHaveBeenCalled();
		expect(f.exportConversation).not.toHaveBeenCalled();
	});
	it("rejects stale Pi launches before reading and hides private source failures", async () => {
		const f = piFixture();
		await expect(
			handleReadTaskConversation(scope, { ...request, sessionInstanceId: "old" }, f.dependencies),
		).resolves.toEqual({ ok: false, error: "The Pi session is no longer connected. Open the task and try again." });
		expect(f.exportPiConversation).not.toHaveBeenCalled();
		f.exportPiConversation.mockRejectedValue(new Error("private path"));
		await expect(handleReadTaskConversation(scope, request, f.dependencies)).resolves.toEqual({
			ok: false,
			error: "Could not read the full Pi conversation. Try again.",
		});
	});
	it.each(["session", "process"])("discards Pi output when the %s changes during reading", async (kind) => {
		const f = piFixture();
		f.exportPiConversation.mockImplementation(async () => {
			if (kind === "session") f.getSummary.mockReturnValue({ ...f.summary, resumeSessionId: "new" });
			else f.getTaskSessionProcessIdentity.mockReturnValue({ ...f.identity, agentId: "pi", pid: 99 });
			return "stale";
		});
		await expect(handleReadTaskConversation(scope, request, f.dependencies)).resolves.toEqual({
			ok: false,
			error: "The Pi conversation changed while copying. Try again.",
		});
	});
});
