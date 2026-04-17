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
	it("treats the home directory as global-only config scope", async () => {
		const { path: tempHome, cleanup: cleanupHome } = createTempDir("quarterdeck-home-runtime-config-home-scope-");

		try {
			await withTemporaryEnv({ home: tempHome }, async () => {
				const state = await loadRuntimeConfig(tempHome);
				expect(state.globalConfigPath).toBe(join(tempHome, ".quarterdeck", "config.json"));
				expect(state.projectConfigPath).toBeNull();
				expect(state.shortcuts).toEqual([]);

				const updated = await updateRuntimeConfig(tempHome, null, {
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

	it("save omits default keys when they were not previously set", async () => {
		const { path: tempHome, cleanup: cleanupHome } = createTempDir("quarterdeck-home-runtime-config-omit-defaults-");
		const { path: tempProject, cleanup: cleanupProject } = createTempDir(
			"quarterdeck-project-runtime-config-omit-defaults-",
		);

		try {
			const runtimeConfigDir = join(tempHome, ".quarterdeck");
			mkdirSync(runtimeConfigDir, { recursive: true });
			writeFileSync(join(runtimeConfigDir, "config.json"), "{}", "utf8");

			await withTemporaryEnv({ home: tempHome }, async () => {
				await loadRuntimeConfig(tempProject);
				await saveRuntimeConfig(
					tempProject,
					null,
					createDefaultSavePayload() as Parameters<typeof saveRuntimeConfig>[2],
				);

				const globalPayload = JSON.parse(readFileSync(join(tempHome, ".quarterdeck", "config.json"), "utf8")) as {
					selectedAgentId?: string;
					agentAutonomousModeEnabled?: boolean;
					readyForReviewNotificationsEnabled?: boolean;
				};
				expect(globalPayload.selectedAgentId).toBeUndefined();
				expect(globalPayload.agentAutonomousModeEnabled).toBeUndefined();
				expect(globalPayload.readyForReviewNotificationsEnabled).toBeUndefined();
				expect(existsSync(join(tempProject, ".quarterdeck", "config.json"))).toBe(false);
			});
		} finally {
			cleanupProject();
			cleanupHome();
		}
	});

	it("removes an existing empty project config file when no shortcuts are saved", async () => {
		const { path: tempHome, cleanup: cleanupHome } = createTempDir("quarterdeck-home-runtime-config-cleanup-empty-");
		const { path: tempProject, cleanup: cleanupProject } = createTempDir(
			"quarterdeck-project-runtime-config-cleanup-empty-",
		);

		try {
			const runtimeProjectConfigDir = join(tempProject, ".quarterdeck");
			mkdirSync(runtimeProjectConfigDir, { recursive: true });
			writeFileSync(join(runtimeProjectConfigDir, "config.json"), "{}", "utf8");

			await withTemporaryEnv({ home: tempHome }, async () => {
				await loadRuntimeConfig(tempProject);
				await saveRuntimeConfig(
					tempProject,
					null,
					createDefaultSavePayload({
						selectedAgentId: "codex",
						agentAutonomousModeEnabled: true,
					}) as Parameters<typeof saveRuntimeConfig>[2],
				);

				expect(existsSync(join(tempProject, ".quarterdeck", "config.json"))).toBe(false);
			});
		} finally {
			cleanupProject();
			cleanupHome();
		}
	});

	it("removes the project config file when the last shortcut is deleted", async () => {
		const { path: tempHome, cleanup: cleanupHome } = createTempDir("quarterdeck-home-runtime-config-remove-last-");
		const { path: tempProject, cleanup: cleanupProject } = createTempDir(
			"quarterdeck-project-runtime-config-remove-last-",
		);

		try {
			await withTemporaryEnv({ home: tempHome }, async () => {
				await loadRuntimeConfig(tempProject);
				await saveRuntimeConfig(
					tempProject,
					null,
					createDefaultSavePayload({
						selectedAgentId: "codex",
						agentAutonomousModeEnabled: true,
						shortcuts: [{ label: "Ship", command: "npm run ship", icon: "rocket" }],
					}) as Parameters<typeof saveRuntimeConfig>[2],
				);
				expect(existsSync(join(tempProject, ".quarterdeck", "config.json"))).toBe(true);

				await updateRuntimeConfig(tempProject, null, {
					shortcuts: [],
				});

				expect(existsSync(join(tempProject, ".quarterdeck", "config.json"))).toBe(false);
			});
		} finally {
			cleanupProject();
			cleanupHome();
		}
	});

	it("updateRuntimeConfig supports partial updates", async () => {
		const { path: tempHome, cleanup: cleanupHome } = createTempDir("quarterdeck-home-runtime-config-partial-");
		const { path: tempProject, cleanup: cleanupProject } = createTempDir(
			"quarterdeck-project-runtime-config-partial-",
		);

		try {
			await withTemporaryEnv({ home: tempHome }, async () => {
				await loadRuntimeConfig(tempProject);

				const updated = await updateRuntimeConfig(tempProject, null, {
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
			cleanupProject();
			cleanupHome();
		}
	});

	it("persists autonomous mode when enabled", async () => {
		const { path: tempHome, cleanup: cleanupHome } = createTempDir(
			"quarterdeck-home-runtime-config-autonomous-enabled-",
		);
		const { path: tempProject, cleanup: cleanupProject } = createTempDir(
			"quarterdeck-project-runtime-config-autonomous-enabled-",
		);

		try {
			await withTemporaryEnv({ home: tempHome }, async () => {
				const updated = await updateRuntimeConfig(tempProject, null, {
					agentAutonomousModeEnabled: true,
				});
				expect(updated.agentAutonomousModeEnabled).toBe(true);

				const globalPayload = JSON.parse(readFileSync(join(tempHome, ".quarterdeck", "config.json"), "utf8")) as {
					agentAutonomousModeEnabled?: boolean;
				};
				expect(globalPayload.agentAutonomousModeEnabled).toBe(true);

				const reloaded = await loadRuntimeConfig(tempProject);
				expect(reloaded.agentAutonomousModeEnabled).toBe(true);
			});
		} finally {
			cleanupProject();
			cleanupHome();
		}
	});

	it("preserves concurrent config updates across processes", async () => {
		const { path: tempHome, cleanup: cleanupHome } = createTempDir("quarterdeck-home-runtime-config-concurrent-");
		const { path: tempProject, cleanup: cleanupProject } = createTempDir(
			"quarterdeck-project-runtime-config-concurrent-",
		);

		try {
			await withTemporaryEnv({ home: tempHome }, async () => {
				await loadRuntimeConfig(tempProject);

				const [selectedAgentState, autonomousModeState] = await Promise.all([
					updateRuntimeConfig(tempProject, null, {
						selectedAgentId: "codex",
					}),
					updateRuntimeConfig(tempProject, null, {
						agentAutonomousModeEnabled: false,
					}),
				]);

				expect(selectedAgentState.selectedAgentId).toBe("codex");
				expect(autonomousModeState.agentAutonomousModeEnabled).toBe(false);

				const reloaded = await loadRuntimeConfig(tempProject);
				expect(reloaded.selectedAgentId).toBe("codex");
				expect(reloaded.agentAutonomousModeEnabled).toBe(false);
			});
		} finally {
			cleanupProject();
			cleanupHome();
		}
	});
});
