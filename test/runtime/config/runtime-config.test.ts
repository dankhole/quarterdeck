import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { delimiter, join } from "node:path";

import { describe, expect, it } from "vitest";

import {
	DEFAULT_PROMPT_SHORTCUTS,
	loadGlobalRuntimeConfig,
	loadRuntimeConfig,
	normalizePromptShortcuts,
	pickBestInstalledAgentIdFromDetected,
	saveRuntimeConfig,
	updateRuntimeConfig,
} from "../../../src/config/runtime-config";
import { getWorkspacePinnedBranchesPath } from "../../../src/state/workspace-state-utils";
import { createTempDir } from "../../utilities/temp-dir";

function withTemporaryEnv<T>(
	input: {
		home: string;
		pathPrefix?: string;
		replacePath?: boolean;
	},
	run: () => Promise<T>,
): Promise<T> {
	const previousHome = process.env.HOME;
	const previousUserProfile = process.env.USERPROFILE;
	const previousPath = process.env.PATH;
	process.env.HOME = input.home;
	process.env.USERPROFILE = input.home;
	if (input.pathPrefix) {
		process.env.PATH = input.replacePath
			? input.pathPrefix
			: previousPath
				? `${input.pathPrefix}${delimiter}${previousPath}`
				: input.pathPrefix;
	}
	return run().finally(() => {
		if (previousHome === undefined) {
			delete process.env.HOME;
		} else {
			process.env.HOME = previousHome;
		}
		if (previousUserProfile === undefined) {
			delete process.env.USERPROFILE;
		} else {
			process.env.USERPROFILE = previousUserProfile;
		}
		if (input.pathPrefix) {
			if (previousPath === undefined) {
				delete process.env.PATH;
			} else {
				process.env.PATH = previousPath;
			}
		}
	});
}

function writeFakeCommand(binDir: string, command: string): void {
	mkdirSync(binDir, { recursive: true });
	if (process.platform === "win32") {
		const scriptPath = join(binDir, `${command}.cmd`);
		writeFileSync(scriptPath, "@echo off\r\nexit /b 0\r\n", "utf8");
		return;
	}
	const scriptPath = join(binDir, command);
	writeFileSync(scriptPath, "#!/bin/sh\nexit 0\n", "utf8");
	chmodSync(scriptPath, 0o755);
}

describe.sequential("runtime-config auto agent selection", () => {
	it("selects agents using the configured priority order", () => {
		expect(pickBestInstalledAgentIdFromDetected(["codex"])).toBe("codex");
		expect(pickBestInstalledAgentIdFromDetected(["claude", "codex"])).toBe("claude");
		expect(pickBestInstalledAgentIdFromDetected([])).toBeNull();
	});

	it("auto-selects and persists when unset", async () => {
		if (process.platform === "win32") {
			return;
		}
		const { path: tempHome, cleanup: cleanupHome } = createTempDir("quarterdeck-home-runtime-config-");
		const { path: tempProject, cleanup: cleanupProject } = createTempDir("quarterdeck-project-runtime-config-");
		const { path: tempBin, cleanup: cleanupBin } = createTempDir("quarterdeck-bin-runtime-config-");

		try {
			writeFakeCommand(tempBin, "codex");

			const previousShell = process.env.SHELL;
			try {
				process.env.SHELL = "/definitely-not-a-shell";
				const isolatedPath = `${tempBin}${delimiter}/usr/bin${delimiter}/bin`;
				await withTemporaryEnv({ home: tempHome, pathPrefix: isolatedPath, replacePath: true }, async () => {
					const state = await loadRuntimeConfig(tempProject);
					expect(state.selectedAgentId).toBe("codex");
					const persisted = JSON.parse(readFileSync(join(tempHome, ".quarterdeck", "config.json"), "utf8")) as {
						selectedAgentId?: string;
						agentAutonomousModeEnabled?: boolean;
						readyForReviewNotificationsEnabled?: boolean;
					};
					expect(persisted.selectedAgentId).toBe("codex");
					expect(persisted.agentAutonomousModeEnabled).toBeUndefined();
					expect(persisted.readyForReviewNotificationsEnabled).toBeUndefined();

					const reloadedState = await loadRuntimeConfig(tempProject);
					expect(reloadedState.selectedAgentId).toBe("codex");
				});
			} finally {
				if (previousShell === undefined) {
					delete process.env.SHELL;
				} else {
					process.env.SHELL = previousShell;
				}
			}
		} finally {
			cleanupBin();
			cleanupProject();
			cleanupHome();
		}
	});

	it("does not write config when no supported CLI is detected", async () => {
		if (process.platform === "win32") {
			return;
		}
		const { path: tempHome, cleanup: cleanupHome } = createTempDir("quarterdeck-home-runtime-config-default-");
		const { path: tempProject, cleanup: cleanupProject } = createTempDir(
			"quarterdeck-project-runtime-config-default-",
		);
		const { path: tempBin, cleanup: cleanupBin } = createTempDir("quarterdeck-bin-runtime-config-default-");

		try {
			const previousShell = process.env.SHELL;
			try {
				process.env.SHELL = "/definitely-not-a-shell";
				await withTemporaryEnv({ home: tempHome, pathPrefix: tempBin, replacePath: true }, async () => {
					const state = await loadRuntimeConfig(tempProject);
					expect(state.selectedAgentId).toBe("claude");
					expect(existsSync(join(tempHome, ".quarterdeck", "config.json"))).toBe(false);
				});
			} finally {
				if (previousShell === undefined) {
					delete process.env.SHELL;
				} else {
					process.env.SHELL = previousShell;
				}
			}
		} finally {
			cleanupBin();
			cleanupProject();
			cleanupHome();
		}
	});

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

	it("normalizes unsupported configured agents to the default launch agent", async () => {
		const { path: tempHome, cleanup: cleanupHome } = createTempDir("quarterdeck-home-runtime-config-set-");
		const { path: tempProject, cleanup: cleanupProject } = createTempDir("quarterdeck-project-runtime-config-set-");
		const { path: tempBin, cleanup: cleanupBin } = createTempDir("quarterdeck-bin-runtime-config-set-");

		try {
			writeFakeCommand(tempBin, "claude");
			writeFakeCommand(tempBin, "codex");

			const runtimeConfigDir = join(tempHome, ".quarterdeck");
			mkdirSync(runtimeConfigDir, { recursive: true });
			writeFileSync(
				join(runtimeConfigDir, "config.json"),
				JSON.stringify(
					{
						selectedAgentId: "invalid-agent",
					},
					null,
					2,
				),
				"utf8",
			);

			await withTemporaryEnv({ home: tempHome, pathPrefix: tempBin }, async () => {
				const state = await loadRuntimeConfig(tempProject);
				expect(state.selectedAgentId).toBe("claude");
			});
		} finally {
			cleanupBin();
			cleanupProject();
			cleanupHome();
		}
	});

	it("does not auto-select when global config file already exists without selected agent", async () => {
		const { path: tempHome, cleanup: cleanupHome } = createTempDir("quarterdeck-home-runtime-config-existing-");
		const { path: tempProject, cleanup: cleanupProject } = createTempDir(
			"quarterdeck-project-runtime-config-existing-",
		);
		const { path: tempBin, cleanup: cleanupBin } = createTempDir("quarterdeck-bin-runtime-config-existing-");

		try {
			writeFakeCommand(tempBin, "codex");

			const runtimeConfigDir = join(tempHome, ".quarterdeck");
			mkdirSync(runtimeConfigDir, { recursive: true });
			writeFileSync(
				join(runtimeConfigDir, "config.json"),
				JSON.stringify(
					{
						readyForReviewNotificationsEnabled: true,
					},
					null,
					2,
				),
				"utf8",
			);

			await withTemporaryEnv({ home: tempHome, pathPrefix: tempBin }, async () => {
				const state = await loadRuntimeConfig(tempProject);
				expect(state.selectedAgentId).toBe("claude");
			});
		} finally {
			cleanupBin();
			cleanupProject();
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
				await saveRuntimeConfig(tempProject, null, {
					selectedAgentId: "claude",
					selectedShortcutLabel: null,
					agentAutonomousModeEnabled: false,
					readyForReviewNotificationsEnabled: true,
					shellAutoRestartEnabled: true,
					showSummaryOnCards: false,
					autoGenerateSummary: false,
					summaryStaleAfterSeconds: 300,
					showTrashWorktreeNotice: true,
					uncommittedChangesOnCardsEnabled: true,
					unmergedChangesIndicatorEnabled: true,
					behindBaseIndicatorEnabled: true,
					skipTaskCheckoutConfirmation: false,
					skipHomeCheckoutConfirmation: false,
					skipCherryPickConfirmation: false,
					audibleNotificationsEnabled: true,
					audibleNotificationVolume: 0.7,
					audibleNotificationEvents: { permission: true, review: true, failure: true },
					audibleNotificationsOnlyWhenHidden: true,
					audibleNotificationSuppressCurrentProject: {
						permission: false,
						review: false,
						failure: false,
					},
					focusedTaskPollMs: 2000,
					backgroundTaskPollMs: 5000,
					homeRepoPollMs: 10000,
					statuslineEnabled: true,
					terminalFontWeight: 325,
					terminalWebGLRenderer: true,
					worktreeAddParentGitDir: false,
					worktreeAddQuarterdeckDir: false,
					showRunningTaskEmergencyActions: false,
					eventLogEnabled: false,
					logLevel: "warn",
					defaultBaseRef: "",
					backupIntervalMinutes: 30,
					shortcuts: [],
					pinnedBranches: [],
					promptShortcuts: [],
					hiddenDefaultPromptShortcuts: [],
				});

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
				await saveRuntimeConfig(tempProject, null, {
					selectedAgentId: "codex",
					selectedShortcutLabel: null,
					agentAutonomousModeEnabled: true,
					readyForReviewNotificationsEnabled: true,
					shellAutoRestartEnabled: true,
					showSummaryOnCards: false,
					autoGenerateSummary: false,
					summaryStaleAfterSeconds: 300,
					showTrashWorktreeNotice: true,
					uncommittedChangesOnCardsEnabled: true,
					unmergedChangesIndicatorEnabled: true,
					behindBaseIndicatorEnabled: true,
					skipTaskCheckoutConfirmation: false,
					skipHomeCheckoutConfirmation: false,
					skipCherryPickConfirmation: false,
					audibleNotificationsEnabled: true,
					audibleNotificationVolume: 0.7,
					audibleNotificationEvents: { permission: true, review: true, failure: true },
					audibleNotificationsOnlyWhenHidden: true,
					audibleNotificationSuppressCurrentProject: {
						permission: false,
						review: false,
						failure: false,
					},
					focusedTaskPollMs: 2000,
					backgroundTaskPollMs: 5000,
					homeRepoPollMs: 10000,
					statuslineEnabled: true,
					terminalFontWeight: 325,
					terminalWebGLRenderer: true,
					worktreeAddParentGitDir: false,
					worktreeAddQuarterdeckDir: false,
					showRunningTaskEmergencyActions: false,
					eventLogEnabled: false,
					logLevel: "warn",
					defaultBaseRef: "",
					backupIntervalMinutes: 30,
					shortcuts: [],
					pinnedBranches: [],
					promptShortcuts: [],
					hiddenDefaultPromptShortcuts: [],
				});

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
				await saveRuntimeConfig(tempProject, null, {
					selectedAgentId: "codex",
					selectedShortcutLabel: null,
					agentAutonomousModeEnabled: true,
					readyForReviewNotificationsEnabled: true,
					shellAutoRestartEnabled: true,
					showSummaryOnCards: false,
					autoGenerateSummary: false,
					summaryStaleAfterSeconds: 300,
					showTrashWorktreeNotice: true,
					uncommittedChangesOnCardsEnabled: true,
					unmergedChangesIndicatorEnabled: true,
					behindBaseIndicatorEnabled: true,
					skipTaskCheckoutConfirmation: false,
					skipHomeCheckoutConfirmation: false,
					skipCherryPickConfirmation: false,
					audibleNotificationsEnabled: true,
					audibleNotificationVolume: 0.7,
					audibleNotificationEvents: { permission: true, review: true, failure: true },
					audibleNotificationsOnlyWhenHidden: true,
					audibleNotificationSuppressCurrentProject: {
						permission: false,
						review: false,
						failure: false,
					},
					focusedTaskPollMs: 2000,
					backgroundTaskPollMs: 5000,
					homeRepoPollMs: 10000,
					statuslineEnabled: true,
					terminalFontWeight: 325,
					terminalWebGLRenderer: true,
					worktreeAddParentGitDir: false,
					worktreeAddQuarterdeckDir: false,
					showRunningTaskEmergencyActions: false,
					eventLogEnabled: false,
					logLevel: "warn",
					defaultBaseRef: "",
					backupIntervalMinutes: 30,
					shortcuts: [{ label: "Ship", command: "npm run ship", icon: "rocket" }],
					pinnedBranches: [],
					promptShortcuts: [],
					hiddenDefaultPromptShortcuts: [],
				});
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

	it("loads default audible notification settings when config is empty", async () => {
		const { path: tempHome, cleanup: cleanupHome } = createTempDir(
			"quarterdeck-home-runtime-config-audible-defaults-",
		);
		const { path: tempProject, cleanup: cleanupProject } = createTempDir(
			"quarterdeck-project-runtime-config-audible-defaults-",
		);

		try {
			await withTemporaryEnv({ home: tempHome }, async () => {
				const state = await loadRuntimeConfig(tempProject);
				expect(state.audibleNotificationsEnabled).toBe(true);
				expect(state.audibleNotificationVolume).toBe(0.7);
				expect(state.audibleNotificationEvents).toEqual({
					permission: true,
					review: true,
					failure: true,
				});
			});
		} finally {
			cleanupProject();
			cleanupHome();
		}
	});

	it("persists audible notification settings to config file", async () => {
		const { path: tempHome, cleanup: cleanupHome } = createTempDir(
			"quarterdeck-home-runtime-config-audible-roundtrip-",
		);
		const { path: tempProject, cleanup: cleanupProject } = createTempDir(
			"quarterdeck-project-runtime-config-audible-roundtrip-",
		);

		try {
			await withTemporaryEnv({ home: tempHome }, async () => {
				const updated = await updateRuntimeConfig(tempProject, null, {
					audibleNotificationsEnabled: false,
					audibleNotificationVolume: 0.3,
					audibleNotificationEvents: { permission: false, review: true, failure: false },
				});
				expect(updated.audibleNotificationsEnabled).toBe(false);
				expect(updated.audibleNotificationVolume).toBe(0.3);
				expect(updated.audibleNotificationEvents).toEqual({
					permission: false,
					review: true,
					failure: false,
				});

				const reloaded = await loadRuntimeConfig(tempProject);
				expect(reloaded.audibleNotificationsEnabled).toBe(false);
				expect(reloaded.audibleNotificationVolume).toBe(0.3);
				expect(reloaded.audibleNotificationEvents).toEqual({
					permission: false,
					review: true,
					failure: false,
				});
			});
		} finally {
			cleanupProject();
			cleanupHome();
		}
	});

	it("merges partial audible notification events with defaults", async () => {
		const { path: tempHome, cleanup: cleanupHome } = createTempDir(
			"quarterdeck-home-runtime-config-audible-partial-",
		);
		const { path: tempProject, cleanup: cleanupProject } = createTempDir(
			"quarterdeck-project-runtime-config-audible-partial-",
		);

		try {
			const runtimeConfigDir = join(tempHome, ".quarterdeck");
			mkdirSync(runtimeConfigDir, { recursive: true });
			writeFileSync(
				join(runtimeConfigDir, "config.json"),
				JSON.stringify({ audibleNotificationEvents: { permission: false } }, null, 2),
				"utf8",
			);

			await withTemporaryEnv({ home: tempHome }, async () => {
				const state = await loadRuntimeConfig(tempProject);
				expect(state.audibleNotificationEvents.permission).toBe(false);
				expect(state.audibleNotificationEvents.review).toBe(true);
				expect(state.audibleNotificationEvents.failure).toBe(true);
			});
		} finally {
			cleanupProject();
			cleanupHome();
		}
	});

	it("handles missing audible fields in existing config gracefully", async () => {
		const { path: tempHome, cleanup: cleanupHome } = createTempDir(
			"quarterdeck-home-runtime-config-audible-backcompat-",
		);
		const { path: tempProject, cleanup: cleanupProject } = createTempDir(
			"quarterdeck-project-runtime-config-audible-backcompat-",
		);

		try {
			const runtimeConfigDir = join(tempHome, ".quarterdeck");
			mkdirSync(runtimeConfigDir, { recursive: true });
			writeFileSync(
				join(runtimeConfigDir, "config.json"),
				JSON.stringify({ selectedAgentId: "claude" }, null, 2),
				"utf8",
			);

			await withTemporaryEnv({ home: tempHome }, async () => {
				const state = await loadRuntimeConfig(tempProject);
				expect(state.audibleNotificationsEnabled).toBe(true);
				expect(state.audibleNotificationVolume).toBe(0.7);
				expect(state.audibleNotificationEvents).toEqual({
					permission: true,
					review: true,
					failure: true,
				});
			});
		} finally {
			cleanupProject();
			cleanupHome();
		}
	});

	it("existing config fields preserved after adding audio settings", async () => {
		const { path: tempHome, cleanup: cleanupHome } = createTempDir(
			"quarterdeck-home-runtime-config-audible-preserve-",
		);
		const { path: tempProject, cleanup: cleanupProject } = createTempDir(
			"quarterdeck-project-runtime-config-audible-preserve-",
		);

		try {
			await withTemporaryEnv({ home: tempHome }, async () => {
				await updateRuntimeConfig(tempProject, null, { selectedAgentId: "codex" });

				const afterAgentChange = await loadRuntimeConfig(tempProject);
				expect(afterAgentChange.selectedAgentId).toBe("codex");

				await updateRuntimeConfig(tempProject, null, {
					audibleNotificationsEnabled: false,
					audibleNotificationVolume: 0.4,
				});

				const reloaded = await loadRuntimeConfig(tempProject);
				expect(reloaded.selectedAgentId).toBe("codex");
				expect(reloaded.audibleNotificationsEnabled).toBe(false);
				expect(reloaded.audibleNotificationVolume).toBe(0.4);
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

describe.sequential("prompt shortcuts config persistence", () => {
	it("returns default prompt shortcuts when none configured", async () => {
		const { path: tempHome, cleanup: cleanupHome } = createTempDir("quarterdeck-home-prompt-shortcuts-default-");
		const { path: tempProject, cleanup: cleanupProject } = createTempDir(
			"quarterdeck-project-prompt-shortcuts-default-",
		);

		try {
			await withTemporaryEnv({ home: tempHome }, async () => {
				const state = await loadRuntimeConfig(tempProject);
				expect(state.promptShortcuts).toHaveLength(2);
				expect(state.promptShortcuts[0]?.label).toBe("Commit");
				expect(state.promptShortcuts[0]?.prompt).toContain("commit your working changes");
				expect(state.promptShortcuts[1]?.label).toBe("Squash Merge");
				expect(state.promptShortcuts[1]?.prompt).toContain("commit-tree");
			});
		} finally {
			cleanupProject();
			cleanupHome();
		}
	});

	it("persists and loads prompt shortcuts", async () => {
		const { path: tempHome, cleanup: cleanupHome } = createTempDir("quarterdeck-home-prompt-shortcuts-persist-");
		const { path: tempProject, cleanup: cleanupProject } = createTempDir(
			"quarterdeck-project-prompt-shortcuts-persist-",
		);

		try {
			await withTemporaryEnv({ home: tempHome }, async () => {
				await loadRuntimeConfig(tempProject);
				const customShortcuts = [
					{ label: "Ship", prompt: "push to main" },
					{ label: "Fix", prompt: "fix the bug" },
				];
				await updateRuntimeConfig(tempProject, null, { promptShortcuts: customShortcuts });

				const reloaded = await loadRuntimeConfig(tempProject);
				// User's 2 shortcuts + 2 defaults (Commit, Squash Merge) merged in
				expect(reloaded.promptShortcuts).toHaveLength(4);
				expect(reloaded.promptShortcuts[0]?.label).toBe("Ship");
				expect(reloaded.promptShortcuts[0]?.prompt).toBe("push to main");
				expect(reloaded.promptShortcuts[1]?.label).toBe("Fix");
				expect(reloaded.promptShortcuts[1]?.prompt).toBe("fix the bug");
				expect(reloaded.promptShortcuts[2]?.label).toBe("Commit");
				expect(reloaded.promptShortcuts[3]?.label).toBe("Squash Merge");

				// On-disk config only has the user's shortcuts
				const globalConfigRaw = readFileSync(join(tempHome, ".quarterdeck", "config.json"), "utf8");
				const globalConfig = JSON.parse(globalConfigRaw) as { promptShortcuts?: unknown[] };
				expect(globalConfig.promptShortcuts).toHaveLength(2);
			});
		} finally {
			cleanupProject();
			cleanupHome();
		}
	});

	it("filters invalid prompt shortcuts", async () => {
		const { path: tempHome, cleanup: cleanupHome } = createTempDir("quarterdeck-home-prompt-shortcuts-invalid-");
		const { path: tempProject, cleanup: cleanupProject } = createTempDir(
			"quarterdeck-project-prompt-shortcuts-invalid-",
		);

		try {
			await withTemporaryEnv({ home: tempHome }, async () => {
				await loadRuntimeConfig(tempProject);
				// Manually write config with invalid entries
				const configPath = join(tempHome, ".quarterdeck", "config.json");
				writeFileSync(
					configPath,
					JSON.stringify({
						promptShortcuts: [
							{ label: "", prompt: "test" },
							{ label: "Valid", prompt: "" },
							{ label: "Good", prompt: "real prompt" },
						],
					}),
				);

				const reloaded = await loadRuntimeConfig(tempProject);
				// 1 valid user shortcut + 2 defaults merged in
				expect(reloaded.promptShortcuts).toHaveLength(3);
				expect(reloaded.promptShortcuts[0]?.label).toBe("Good");
				expect(reloaded.promptShortcuts[1]?.label).toBe("Commit");
				expect(reloaded.promptShortcuts[2]?.label).toBe("Squash Merge");
			});
		} finally {
			cleanupProject();
			cleanupHome();
		}
	});

	it("falls back to defaults when all shortcuts are invalid", async () => {
		const { path: tempHome, cleanup: cleanupHome } = createTempDir("quarterdeck-home-prompt-shortcuts-all-invalid-");
		const { path: tempProject, cleanup: cleanupProject } = createTempDir(
			"quarterdeck-project-prompt-shortcuts-all-invalid-",
		);

		try {
			await withTemporaryEnv({ home: tempHome }, async () => {
				await loadRuntimeConfig(tempProject);
				const configPath = join(tempHome, ".quarterdeck", "config.json");
				writeFileSync(configPath, JSON.stringify({ promptShortcuts: [{ label: "", prompt: "" }] }));

				const reloaded = await loadRuntimeConfig(tempProject);
				expect(reloaded.promptShortcuts).toHaveLength(2);
				expect(reloaded.promptShortcuts[0]?.label).toBe("Commit");
			});
		} finally {
			cleanupProject();
			cleanupHome();
		}
	});

	it("returns defaults when promptShortcuts is not an array", () => {
		expect(normalizePromptShortcuts("not-an-array" as unknown as null)).toEqual([...DEFAULT_PROMPT_SHORTCUTS]);
		expect(normalizePromptShortcuts(42 as unknown as null)).toEqual([...DEFAULT_PROMPT_SHORTCUTS]);
		expect(normalizePromptShortcuts({ label: "X", prompt: "Y" } as unknown as null)).toEqual([
			...DEFAULT_PROMPT_SHORTCUTS,
		]);
		expect(normalizePromptShortcuts(null)).toEqual([...DEFAULT_PROMPT_SHORTCUTS]);
		expect(normalizePromptShortcuts(undefined)).toEqual([...DEFAULT_PROMPT_SHORTCUTS]);
	});
});

describe.sequential("pinned branches workspace storage", () => {
	it("reads pinned branches from workspace directory when workspaceId is provided", async () => {
		const { path: tempHome, cleanup: cleanupHome } = createTempDir("quarterdeck-home-pinned-read-");
		const { path: tempProject, cleanup: cleanupProject } = createTempDir("quarterdeck-project-pinned-read-");
		const workspaceId = "test-project";

		try {
			await withTemporaryEnv({ home: tempHome }, async () => {
				const pinnedPath = getWorkspacePinnedBranchesPath(workspaceId);
				mkdirSync(join(tempHome, ".quarterdeck", "workspaces", workspaceId), { recursive: true });
				writeFileSync(pinnedPath, JSON.stringify(["main", "develop"]));

				const state = await loadRuntimeConfig(tempProject, workspaceId);
				expect(state.pinnedBranches).toEqual(["main", "develop"]);
			});
		} finally {
			cleanupProject();
			cleanupHome();
		}
	});

	it("writes pinned branches to workspace directory via updateRuntimeConfig", async () => {
		const { path: tempHome, cleanup: cleanupHome } = createTempDir("quarterdeck-home-pinned-write-");
		const { path: tempProject, cleanup: cleanupProject } = createTempDir("quarterdeck-project-pinned-write-");
		const workspaceId = "test-project";

		try {
			await withTemporaryEnv({ home: tempHome }, async () => {
				mkdirSync(join(tempHome, ".quarterdeck", "workspaces", workspaceId), { recursive: true });

				const updated = await updateRuntimeConfig(tempProject, workspaceId, {
					pinnedBranches: ["main", "feature-1"],
				});
				expect(updated.pinnedBranches).toEqual(["main", "feature-1"]);

				const pinnedPath = getWorkspacePinnedBranchesPath(workspaceId);
				const onDisk = JSON.parse(readFileSync(pinnedPath, "utf8")) as string[];
				expect(onDisk).toEqual(["main", "feature-1"]);

				// Verify project config does NOT contain pinnedBranches
				const projectConfigPath = join(tempProject, ".quarterdeck", "config.json");
				expect(existsSync(projectConfigPath)).toBe(false);
			});
		} finally {
			cleanupProject();
			cleanupHome();
		}
	});

	it("returns empty pinned branches when workspaceId is null", async () => {
		const { path: tempHome, cleanup: cleanupHome } = createTempDir("quarterdeck-home-pinned-null-");
		const { path: tempProject, cleanup: cleanupProject } = createTempDir("quarterdeck-project-pinned-null-");

		try {
			await withTemporaryEnv({ home: tempHome }, async () => {
				const state = await loadRuntimeConfig(tempProject);
				expect(state.pinnedBranches).toEqual([]);
			});
		} finally {
			cleanupProject();
			cleanupHome();
		}
	});

	it("removes pinned-branches.json when all branches are unpinned", async () => {
		const { path: tempHome, cleanup: cleanupHome } = createTempDir("quarterdeck-home-pinned-remove-");
		const { path: tempProject, cleanup: cleanupProject } = createTempDir("quarterdeck-project-pinned-remove-");
		const workspaceId = "test-project";

		try {
			await withTemporaryEnv({ home: tempHome }, async () => {
				const pinnedPath = getWorkspacePinnedBranchesPath(workspaceId);
				mkdirSync(join(tempHome, ".quarterdeck", "workspaces", workspaceId), { recursive: true });
				writeFileSync(pinnedPath, JSON.stringify(["main"]));

				await updateRuntimeConfig(tempProject, workspaceId, { pinnedBranches: [] });
				expect(existsSync(pinnedPath)).toBe(false);
			});
		} finally {
			cleanupProject();
			cleanupHome();
		}
	});

	it("ignores pinnedBranches in legacy project config file", async () => {
		const { path: tempHome, cleanup: cleanupHome } = createTempDir("quarterdeck-home-pinned-legacy-");
		const { path: tempProject, cleanup: cleanupProject } = createTempDir("quarterdeck-project-pinned-legacy-");
		const workspaceId = "test-project";

		try {
			await withTemporaryEnv({ home: tempHome }, async () => {
				// Write legacy project config with pinnedBranches
				const projectConfigDir = join(tempProject, ".quarterdeck");
				mkdirSync(projectConfigDir, { recursive: true });
				writeFileSync(join(projectConfigDir, "config.json"), JSON.stringify({ pinnedBranches: ["old-branch"] }));

				// Create workspace dir but no pinned-branches.json
				mkdirSync(join(tempHome, ".quarterdeck", "workspaces", workspaceId), { recursive: true });

				const state = await loadRuntimeConfig(tempProject, workspaceId);
				expect(state.pinnedBranches).toEqual([]);
			});
		} finally {
			cleanupProject();
			cleanupHome();
		}
	});
});
