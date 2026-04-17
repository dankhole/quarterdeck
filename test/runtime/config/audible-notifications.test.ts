import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { loadRuntimeConfig, updateRuntimeConfig } from "../../../src/config";
import { createTempDir } from "../../utilities/temp-dir";
import { withTemporaryEnv } from "./runtime-config-helpers";

describe.sequential("audible notification config", () => {
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
});
