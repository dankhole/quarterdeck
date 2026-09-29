import { describe, expect, it, vi } from "vitest";
import type { TerminalSessionManager } from "../../../src/terminal";
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
		profileEnvironment: { HOME: "/tmp/home", CODEX_HOME: "profile" },
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
				codexHome: "/tmp/worktree/profile",
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
