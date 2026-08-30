import { mkdirSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { createProjectRegistry, createRuntimeConversationTaskSessionResolver } from "../../src/server/index.js";
import { loadProjectContext, saveProjectSessions } from "../../src/state/index.js";
import { initGitRepository } from "../utilities/git-env.js";
import { createTestRuntimeConfigState } from "../utilities/runtime-config-factory.js";
import { createTestTaskSessionSummary } from "../utilities/task-session-factory.js";
import { createTempDir, withTemporaryHome } from "../utilities/temp-dir.js";

describe.sequential("runtime conversation session resolver integration", () => {
	it("reads persisted session identity for an indexed project without creating its terminal manager", async () => {
		await withTemporaryHome(async () => {
			const temporary = createTempDir("runtime-conversation-session-");
			try {
				const activeProjectPath = join(temporary.path, "active-project");
				const coldProjectPath = join(temporary.path, "cold-project");
				mkdirSync(activeProjectPath, { recursive: true });
				mkdirSync(coldProjectPath, { recursive: true });
				initGitRepository(activeProjectPath);
				initGitRepository(coldProjectPath);
				const activeContext = await loadProjectContext(activeProjectPath);
				const coldContext = await loadProjectContext(coldProjectPath);
				await saveProjectSessions(coldProjectPath, {
					"cold-task": createTestTaskSessionSummary({
						taskId: "cold-task",
						agentId: "codex",
						resumeSessionId: "codex-cold-session",
						state: "awaiting_review",
						reviewReason: "hook",
					}),
				});
				const config = createTestRuntimeConfigState();
				const registry = await createProjectRegistry({
					cwd: activeProjectPath,
					loadGlobalRuntimeConfig: async () => config,
					loadRuntimeConfig: async () => config,
					hasGitRepository: async () => true,
					pathIsDirectory: async () => true,
				});
				try {
					expect(registry.getTerminalManagerForProject(activeContext.projectId)).not.toBeNull();
					expect(registry.getTerminalManagerForProject(coldContext.projectId)).toBeNull();

					const resolver = createRuntimeConversationTaskSessionResolver(registry);
					await expect(resolver.resolveTaskSession(coldContext.projectId, "cold-task")).resolves.toEqual({
						projectId: coldContext.projectId,
						taskId: "cold-task",
						agentId: "codex",
						providerSessionId: "codex-cold-session",
					});
					expect(registry.getTerminalManagerForProject(coldContext.projectId)).toBeNull();
				} finally {
					registry.stopMaintenance();
					for (const { terminalManager } of registry.listManagedProjects()) {
						terminalManager.stopReconciliation();
						terminalManager.markInterruptedAndStopAll();
						await terminalManager.waitForShutdownQuiescence();
					}
				}
			} finally {
				temporary.cleanup();
			}
		});
	});
});
