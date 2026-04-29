import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
	loadGlobalRuntimeConfig,
	loadRuntimeConfig,
	saveRuntimeConfig,
	updateRuntimeConfig,
} from "../../../src/config";
import { createDefaultRuntimeConfigSaveRequest } from "../../utilities/runtime-config-factory";
import { createTempDir } from "../../utilities/temp-dir";
import { withTemporaryEnv, writeFakeCommand } from "./runtime-config-helpers";

describe.sequential("runtime-config persistence", () => {
	it("treats null projectId as global-only config scope", async () => {
		const { path: tempHome, cleanup: cleanupHome } = createTempDir("quarterdeck-home-runtime-config-home-scope-");
		const { path: tempBin, cleanup: cleanupBin } = createTempDir("quarterdeck-bin-runtime-config-home-scope-");

		try {
			writeFakeCommand(tempBin, "claude");
			await withTemporaryEnv({ home: tempHome, pathPrefix: tempBin, replacePath: true }, async () => {
				const state = await loadRuntimeConfig(null);
				expect(state.globalConfigPath).toBe(join(tempHome, ".quarterdeck", "config.json"));
				expect(state.projectConfigPath).toBeNull();
				expect(state.shortcuts).toEqual([]);

				const updated = await updateRuntimeConfig(null, {
					selectedAgentId: "claude",
				});
				expect(updated.selectedAgentId).toBe("claude");
				expect(updated.projectConfigPath).toBeNull();

				const globalPayload = JSON.parse(readFileSync(join(tempHome, ".quarterdeck", "config.json"), "utf8")) as {
					selectedAgentId?: string;
					shortcuts?: unknown;
				};
				expect(globalPayload.selectedAgentId).toBeUndefined();
				expect(globalPayload.shortcuts).toBeUndefined();
			});
		} finally {
			cleanupBin();
			cleanupHome();
		}
	});

	it("loads global runtime config without a project scope", async () => {
		const { path: tempHome, cleanup: cleanupHome } = createTempDir("quarterdeck-home-runtime-config-global-only-");

		try {
			await withTemporaryEnv({ home: tempHome }, async () => {
				const state = await loadGlobalRuntimeConfig();
				expect(state.globalConfigPath).toBe(join(tempHome, ".quarterdeck", "config.json"));
				expect(state.projectConfigPath).toBeNull();
				expect(state.shortcuts).toEqual([]);
			});
		} finally {
			cleanupHome();
		}
	});

	it("does not inherit a stale global defaultBaseRef into project-scoped config", async () => {
		const { path: tempHome, cleanup: cleanupHome } = createTempDir(
			"quarterdeck-home-runtime-config-project-base-ref-isolation-",
		);
		const projectId = "test-project";

		try {
			const runtimeConfigDir = join(tempHome, ".quarterdeck");
			mkdirSync(runtimeConfigDir, { recursive: true });
			writeFileSync(join(runtimeConfigDir, "config.json"), JSON.stringify({ defaultBaseRef: "main" }), "utf8");
			mkdirSync(join(runtimeConfigDir, "projects", projectId), { recursive: true });

			await withTemporaryEnv({ home: tempHome }, async () => {
				const stateWithoutProjectPin = await loadRuntimeConfig(projectId);
				expect(stateWithoutProjectPin.defaultBaseRef).toBe("");

				await updateRuntimeConfig(projectId, {
					defaultBaseRef: "master",
				});

				const stateWithProjectPin = await loadRuntimeConfig(projectId);
				expect(stateWithProjectPin.defaultBaseRef).toBe("master");
			});
		} finally {
			cleanupHome();
		}
	});

	it("save omits default keys when they were not previously set", async () => {
		const { path: tempHome, cleanup: cleanupHome } = createTempDir("quarterdeck-home-runtime-config-omit-defaults-");
		const projectId = "test-project";

		try {
			const runtimeConfigDir = join(tempHome, ".quarterdeck");
			mkdirSync(runtimeConfigDir, { recursive: true });
			writeFileSync(join(runtimeConfigDir, "config.json"), "{}", "utf8");
			const projectDir = join(runtimeConfigDir, "projects", projectId);
			mkdirSync(projectDir, { recursive: true });

			await withTemporaryEnv({ home: tempHome }, async () => {
				await loadRuntimeConfig(projectId);
				await saveRuntimeConfig(projectId, createDefaultRuntimeConfigSaveRequest());

				const globalPayload = JSON.parse(readFileSync(join(tempHome, ".quarterdeck", "config.json"), "utf8")) as {
					selectedAgentId?: string;
					readyForReviewNotificationsEnabled?: boolean;
				};
				expect(globalPayload.selectedAgentId).toBeUndefined();
				expect(globalPayload.readyForReviewNotificationsEnabled).toBeUndefined();
				expect(existsSync(join(projectDir, "config.json"))).toBe(false);
			});
		} finally {
			cleanupHome();
		}
	});

	it("prunes retired worktree add-dir keys from existing global config", async () => {
		const { path: tempHome, cleanup: cleanupHome } = createTempDir("quarterdeck-home-runtime-config-prune-add-dir-");
		const projectId = "test-project";

		try {
			const runtimeConfigDir = join(tempHome, ".quarterdeck");
			mkdirSync(runtimeConfigDir, { recursive: true });
			writeFileSync(
				join(runtimeConfigDir, "config.json"),
				JSON.stringify({
					worktreeAddParentGitDir: true,
					worktreeAddQuarterdeckDir: true,
				}),
				"utf8",
			);

			await withTemporaryEnv({ home: tempHome }, async () => {
				await saveRuntimeConfig(projectId, createDefaultRuntimeConfigSaveRequest());

				const globalPayload = JSON.parse(
					readFileSync(join(tempHome, ".quarterdeck", "config.json"), "utf8"),
				) as Record<string, unknown>;
				expect(globalPayload).not.toHaveProperty("worktreeAddParentGitDir");
				expect(globalPayload).not.toHaveProperty("worktreeAddQuarterdeckDir");
			});
		} finally {
			cleanupHome();
		}
	});

	it("removes an existing empty project config file when no shortcuts are saved", async () => {
		const { path: tempHome, cleanup: cleanupHome } = createTempDir("quarterdeck-home-runtime-config-cleanup-empty-");
		const { path: tempBin, cleanup: cleanupBin } = createTempDir("quarterdeck-bin-runtime-config-cleanup-empty-");
		const projectId = "test-project";

		try {
			const runtimeConfigDir = join(tempHome, ".quarterdeck");
			const projectDir = join(runtimeConfigDir, "projects", projectId);
			mkdirSync(projectDir, { recursive: true });
			writeFileSync(join(projectDir, "config.json"), "{}", "utf8");

			writeFakeCommand(tempBin, "claude");
			await withTemporaryEnv({ home: tempHome, pathPrefix: tempBin, replacePath: true }, async () => {
				await loadRuntimeConfig(projectId);
				await saveRuntimeConfig(
					projectId,
					createDefaultRuntimeConfigSaveRequest({
						selectedAgentId: "claude",
					}),
				);

				expect(existsSync(join(projectDir, "config.json"))).toBe(false);
			});
		} finally {
			cleanupBin();
			cleanupHome();
		}
	});

	it("removes the project config file when the last shortcut is deleted", async () => {
		const { path: tempHome, cleanup: cleanupHome } = createTempDir("quarterdeck-home-runtime-config-remove-last-");
		const { path: tempBin, cleanup: cleanupBin } = createTempDir("quarterdeck-bin-runtime-config-remove-last-");
		const projectId = "test-project";

		try {
			const projectDir = join(tempHome, ".quarterdeck", "projects", projectId);
			mkdirSync(projectDir, { recursive: true });

			writeFakeCommand(tempBin, "claude");
			await withTemporaryEnv({ home: tempHome, pathPrefix: tempBin, replacePath: true }, async () => {
				await loadRuntimeConfig(projectId);
				await saveRuntimeConfig(
					projectId,
					createDefaultRuntimeConfigSaveRequest({
						selectedAgentId: "claude",
						shortcuts: [{ label: "Ship", command: "npm run ship", icon: "rocket" }],
					}),
				);
				expect(existsSync(join(projectDir, "config.json"))).toBe(true);

				await updateRuntimeConfig(projectId, {
					shortcuts: [],
				});

				expect(existsSync(join(projectDir, "config.json"))).toBe(false);
			});
		} finally {
			cleanupBin();
			cleanupHome();
		}
	});

	it("updateRuntimeConfig supports partial updates", async () => {
		const { path: tempHome, cleanup: cleanupHome } = createTempDir("quarterdeck-home-runtime-config-partial-");
		const { path: tempBin, cleanup: cleanupBin } = createTempDir("quarterdeck-bin-runtime-config-partial-");

		try {
			writeFakeCommand(tempBin, "claude");
			await withTemporaryEnv({ home: tempHome, pathPrefix: tempBin, replacePath: true }, async () => {
				await loadRuntimeConfig(null);

				const updated = await updateRuntimeConfig(null, {
					selectedAgentId: "claude",
				});
				expect(updated.selectedAgentId).toBe("claude");

				const globalPayload = JSON.parse(readFileSync(join(tempHome, ".quarterdeck", "config.json"), "utf8")) as {
					selectedAgentId?: string;
					selectedShortcutLabel?: string;
					readyForReviewNotificationsEnabled?: boolean;
				};
				expect(globalPayload.selectedAgentId).toBeUndefined();
				expect(globalPayload.selectedShortcutLabel).toBeUndefined();
				expect(globalPayload.readyForReviewNotificationsEnabled).toBeUndefined();
			});
		} finally {
			cleanupBin();
			cleanupHome();
		}
	});

	it("preserves concurrent config updates across processes", async () => {
		const { path: tempHome, cleanup: cleanupHome } = createTempDir("quarterdeck-home-runtime-config-concurrent-");
		const { path: tempBin, cleanup: cleanupBin } = createTempDir("quarterdeck-bin-runtime-config-concurrent-");

		try {
			writeFakeCommand(tempBin, "claude");
			await withTemporaryEnv({ home: tempHome, pathPrefix: tempBin, replacePath: true }, async () => {
				await loadRuntimeConfig(null);

				const [selectedAgentState, notificationsState] = await Promise.all([
					updateRuntimeConfig(null, {
						selectedAgentId: "claude",
					}),
					updateRuntimeConfig(null, {
						readyForReviewNotificationsEnabled: false,
					}),
				]);

				expect(selectedAgentState.selectedAgentId).toBe("claude");
				expect(notificationsState.readyForReviewNotificationsEnabled).toBe(false);

				const reloaded = await loadRuntimeConfig(null);
				expect(reloaded.selectedAgentId).toBe("claude");
				expect(reloaded.readyForReviewNotificationsEnabled).toBe(false);
			});
		} finally {
			cleanupBin();
			cleanupHome();
		}
	});
});
