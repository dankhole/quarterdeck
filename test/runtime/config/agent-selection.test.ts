import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { delimiter, join } from "node:path";

import { beforeEach, describe, expect, it } from "vitest";

import {
	loadRuntimeConfig,
	pickBestInstalledAgentIdFromDetected,
	resetAgentAvailabilityCache,
} from "../../../src/config";
import { createTempDir } from "../../utilities/temp-dir";
import { withTemporaryEnv, writeFakeCommand, writeFakeVersionedCommand } from "./runtime-config-helpers";

describe.sequential("runtime-config auto agent selection", () => {
	beforeEach(() => {
		// Each test simulates a distinct PATH/HOME environment; clear the availability
		// cache so probes are re-run against the freshly staged fake binaries.
		resetAgentAvailabilityCache();
	});

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
		const { path: tempBin, cleanup: cleanupBin } = createTempDir("quarterdeck-bin-runtime-config-");

		try {
			writeFakeVersionedCommand(tempBin, "codex", "0.124.0");

			const previousShell = process.env.SHELL;
			try {
				process.env.SHELL = "/definitely-not-a-shell";
				const isolatedPath = `${tempBin}${delimiter}/usr/bin${delimiter}/bin`;
				await withTemporaryEnv({ home: tempHome, pathPrefix: isolatedPath, replacePath: true }, async () => {
					const state = await loadRuntimeConfig(null);
					expect(state.selectedAgentId).toBe("codex");
					expect(existsSync(join(tempHome, ".quarterdeck", "config.json"))).toBe(true);
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
			cleanupHome();
		}
	});

	it("auto-selects Codex when the detected build supports native hooks", async () => {
		if (process.platform === "win32") {
			return;
		}
		const { path: tempHome, cleanup: cleanupHome } = createTempDir("quarterdeck-home-runtime-config-");
		const { path: tempBin, cleanup: cleanupBin } = createTempDir("quarterdeck-bin-runtime-config-");

		try {
			writeFakeVersionedCommand(tempBin, "codex", "0.124.0");

			const previousShell = process.env.SHELL;
			try {
				process.env.SHELL = "/definitely-not-a-shell";
				const isolatedPath = `${tempBin}${delimiter}/usr/bin${delimiter}/bin`;
				await withTemporaryEnv({ home: tempHome, pathPrefix: isolatedPath, replacePath: true }, async () => {
					const state = await loadRuntimeConfig(null);
					expect(state.selectedAgentId).toBe("codex");
					const persisted = JSON.parse(readFileSync(join(tempHome, ".quarterdeck", "config.json"), "utf8")) as {
						selectedAgentId?: string;
						readyForReviewNotificationsEnabled?: boolean;
					};
					expect(persisted.selectedAgentId).toBe("codex");
					expect(persisted.readyForReviewNotificationsEnabled).toBeUndefined();

					const reloadedState = await loadRuntimeConfig(null);
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
			cleanupHome();
		}
	});

	it("does not write config when no supported CLI is detected", async () => {
		if (process.platform === "win32") {
			return;
		}
		const { path: tempHome, cleanup: cleanupHome } = createTempDir("quarterdeck-home-runtime-config-default-");
		const { path: tempBin, cleanup: cleanupBin } = createTempDir("quarterdeck-bin-runtime-config-default-");

		try {
			const previousShell = process.env.SHELL;
			try {
				process.env.SHELL = "/definitely-not-a-shell";
				await withTemporaryEnv({ home: tempHome, pathPrefix: tempBin, replacePath: true }, async () => {
					const state = await loadRuntimeConfig(null);
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
			cleanupHome();
		}
	});

	it("normalizes unsupported configured agents to the default launch agent", async () => {
		const { path: tempHome, cleanup: cleanupHome } = createTempDir("quarterdeck-home-runtime-config-set-");
		const { path: tempBin, cleanup: cleanupBin } = createTempDir("quarterdeck-bin-runtime-config-set-");

		try {
			writeFakeCommand(tempBin, "claude");
			writeFakeCommand(tempBin, "codex");

			const runtimeConfigDir = join(tempHome, ".quarterdeck");
			mkdirSync(runtimeConfigDir, { recursive: true });
			writeFileSync(
				join(runtimeConfigDir, "config.json"),
				JSON.stringify({ selectedAgentId: "invalid-agent" }, null, 2),
				"utf8",
			);

			await withTemporaryEnv({ home: tempHome, pathPrefix: tempBin }, async () => {
				const state = await loadRuntimeConfig(null);
				expect(state.selectedAgentId).toBe("claude");
			});
		} finally {
			cleanupBin();
			cleanupHome();
		}
	});

	it("does not auto-select Codex when the detected version is below the supported floor", async () => {
		if (process.platform === "win32") {
			return;
		}
		const { path: tempHome, cleanup: cleanupHome } = createTempDir("quarterdeck-home-runtime-config-old-codex-");
		const { path: tempBin, cleanup: cleanupBin } = createTempDir("quarterdeck-bin-runtime-config-old-codex-");

		try {
			writeFakeVersionedCommand(tempBin, "codex", "0.123.0");

			await withTemporaryEnv({ home: tempHome, pathPrefix: tempBin, replacePath: true }, async () => {
				const state = await loadRuntimeConfig(null);
				expect(state.selectedAgentId).toBe("claude");
				expect(existsSync(join(tempHome, ".quarterdeck", "config.json"))).toBe(false);
			});
		} finally {
			cleanupBin();
			cleanupHome();
		}
	});

	it("does not auto-select when global config file already exists without selected agent", async () => {
		const { path: tempHome, cleanup: cleanupHome } = createTempDir("quarterdeck-home-runtime-config-existing-");
		const { path: tempBin, cleanup: cleanupBin } = createTempDir("quarterdeck-bin-runtime-config-existing-");

		try {
			writeFakeCommand(tempBin, "codex");

			const runtimeConfigDir = join(tempHome, ".quarterdeck");
			mkdirSync(runtimeConfigDir, { recursive: true });
			writeFileSync(
				join(runtimeConfigDir, "config.json"),
				JSON.stringify({ readyForReviewNotificationsEnabled: true }, null, 2),
				"utf8",
			);

			await withTemporaryEnv({ home: tempHome, pathPrefix: tempBin }, async () => {
				const state = await loadRuntimeConfig(null);
				expect(state.selectedAgentId).toBe("claude");
			});
		} finally {
			cleanupBin();
			cleanupHome();
		}
	});
});
