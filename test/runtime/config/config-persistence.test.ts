import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
	loadGlobalRuntimeConfig,
	loadRuntimeConfig,
	saveRuntimeConfig,
	updateRuntimeConfig,
} from "../../../src/config";
import { createTempDir } from "../../utilities/temp-dir";
import { createDefaultSavePayload, withTemporaryEnv } from "./runtime-config-helpers";

describe.sequential("runtime-config persistence", () => {
	it("treats null projectId as global-only config scope", async () => {
		const { path: tempHome, cleanup: cleanupHome } = createTempDir("quarterdeck-home-runtime-config-home-scope-");

		try {
			await withTemporaryEnv({ home: tempHome }, async () => {
				const state = await loadRuntimeConfig(null);
				expect(state.globalConfigPath).toBe(join(tempHome, ".quarterdeck", "config.json"));
				expect(state.projectConfigPath).toBeNull();
				expect(state.shortcuts).toEqual([]);

				const updated = await updateRuntimeConfig(null, {
					selectedAgentId: "codex",
				});
				expect(updated.selectedAgentId).toBe("codex");
				expect(updated.projectConfigPath).toBeNull();

				const globalPayload = JSON.parse(readFileSync(join(tempHome, ".quarterdeck", "config.json"), "utf8")) as {
					selectedAgentId?: string;
					shortcuts?: unknown;
				};
				expect(globalPayload.selectedAgentId).toBe("codex");
				expect(globalPayload.shortcuts).toBeUndefined();
			});
		} finally {
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
				await saveRuntimeConfig(projectId, createDefaultSavePayload() as Parameters<typeof saveRuntimeConfig>[1]);

				const globalPayload = JSON.parse(readFileSync(join(tempHome, ".quarterdeck", "config.json"), "utf8")) as {
					selectedAgentId?: string;
					agentAutonomousModeEnabled?: boolean;
					readyForReviewNotificationsEnabled?: boolean;
				};
				expect(globalPayload.selectedAgentId).toBeUndefined();
				expect(globalPayload.agentAutonomousModeEnabled).toBeUndefined();
				expect(globalPayload.readyForReviewNotificationsEnabled).toBeUndefined();
				expect(existsSync(join(projectDir, "config.json"))).toBe(false);
			});
		} finally {
			cleanupHome();
		}
	});

	it("removes an existing empty project config file when no shortcuts are saved", async () => {
		const { path: tempHome, cleanup: cleanupHome } = createTempDir("quarterdeck-home-runtime-config-cleanup-empty-");
		const projectId = "test-project";

		try {
			const runtimeConfigDir = join(tempHome, ".quarterdeck");
			const projectDir = join(runtimeConfigDir, "projects", projectId);
			mkdirSync(projectDir, { recursive: true });
			writeFileSync(join(projectDir, "config.json"), "{}", "utf8");

			await withTemporaryEnv({ home: tempHome }, async () => {
				await loadRuntimeConfig(projectId);
				await saveRuntimeConfig(
					projectId,
					createDefaultSavePayload({
						selectedAgentId: "codex",
						agentAutonomousModeEnabled: true,
					}) as Parameters<typeof saveRuntimeConfig>[1],
				);

				expect(existsSync(join(projectDir, "config.json"))).toBe(false);
			});
		} finally {
			cleanupHome();
		}
	});

	it("removes the project config file when the last shortcut is deleted", async () => {
		const { path: tempHome, cleanup: cleanupHome } = createTempDir("quarterdeck-home-runtime-config-remove-last-");
		const projectId = "test-project";

		try {
			const projectDir = join(tempHome, ".quarterdeck", "projects", projectId);
			mkdirSync(projectDir, { recursive: true });

			await withTemporaryEnv({ home: tempHome }, async () => {
				await loadRuntimeConfig(projectId);
				await saveRuntimeConfig(
					projectId,
					createDefaultSavePayload({
						selectedAgentId: "codex",
						agentAutonomousModeEnabled: true,
						shortcuts: [{ label: "Ship", command: "npm run ship", icon: "rocket" }],
					}) as Parameters<typeof saveRuntimeConfig>[1],
				);
				expect(existsSync(join(projectDir, "config.json"))).toBe(true);

				await updateRuntimeConfig(projectId, {
					shortcuts: [],
				});

				expect(existsSync(join(projectDir, "config.json"))).toBe(false);
			});
		} finally {
			cleanupHome();
		}
	});

	it("updateRuntimeConfig supports partial updates", async () => {
		const { path: tempHome, cleanup: cleanupHome } = createTempDir("quarterdeck-home-runtime-config-partial-");

		try {
			await withTemporaryEnv({ home: tempHome }, async () => {
				await loadRuntimeConfig(null);

				const updated = await updateRuntimeConfig(null, {
					selectedAgentId: "codex",
				});
				expect(updated.selectedAgentId).toBe("codex");

				const globalPayload = JSON.parse(readFileSync(join(tempHome, ".quarterdeck", "config.json"), "utf8")) as {
					selectedAgentId?: string;
					selectedShortcutLabel?: string;
					agentAutonomousModeEnabled?: boolean;
					readyForReviewNotificationsEnabled?: boolean;
				};
				expect(globalPayload.selectedAgentId).toBe("codex");
				expect(globalPayload.selectedShortcutLabel).toBeUndefined();
				expect(globalPayload.agentAutonomousModeEnabled).toBeUndefined();
				expect(globalPayload.readyForReviewNotificationsEnabled).toBeUndefined();
			});
		} finally {
			cleanupHome();
		}
	});

	it("persists autonomous mode when enabled", async () => {
		const { path: tempHome, cleanup: cleanupHome } = createTempDir(
			"quarterdeck-home-runtime-config-autonomous-enabled-",
		);

		try {
			await withTemporaryEnv({ home: tempHome }, async () => {
				const updated = await updateRuntimeConfig(null, {
					agentAutonomousModeEnabled: true,
				});
				expect(updated.agentAutonomousModeEnabled).toBe(true);

				const globalPayload = JSON.parse(readFileSync(join(tempHome, ".quarterdeck", "config.json"), "utf8")) as {
					agentAutonomousModeEnabled?: boolean;
				};
				expect(globalPayload.agentAutonomousModeEnabled).toBe(true);

				const reloaded = await loadRuntimeConfig(null);
				expect(reloaded.agentAutonomousModeEnabled).toBe(true);
			});
		} finally {
			cleanupHome();
		}
	});

	it("preserves concurrent config updates across processes", async () => {
		const { path: tempHome, cleanup: cleanupHome } = createTempDir("quarterdeck-home-runtime-config-concurrent-");

		try {
			await withTemporaryEnv({ home: tempHome }, async () => {
				await loadRuntimeConfig(null);

				const [selectedAgentState, autonomousModeState] = await Promise.all([
					updateRuntimeConfig(null, {
						selectedAgentId: "codex",
					}),
					updateRuntimeConfig(null, {
						agentAutonomousModeEnabled: false,
					}),
				]);

				expect(selectedAgentState.selectedAgentId).toBe("codex");
				expect(autonomousModeState.agentAutonomousModeEnabled).toBe(false);

				const reloaded = await loadRuntimeConfig(null);
				expect(reloaded.selectedAgentId).toBe("codex");
				expect(reloaded.agentAutonomousModeEnabled).toBe(false);
			});
		} finally {
			cleanupHome();
		}
	});
});
