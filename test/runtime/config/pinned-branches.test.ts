import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { loadRuntimeConfig, updateRuntimeConfig } from "../../../src/config";
import { getProjectPinnedBranchesPath } from "../../../src/state";
import { createTempDir } from "../../utilities/temp-dir";
import { withTemporaryEnv } from "./runtime-config-helpers";

describe.sequential("pinned branches project storage", () => {
	it("reads pinned branches from project directory when projectId is provided", async () => {
		const { path: tempHome, cleanup: cleanupHome } = createTempDir("quarterdeck-home-pinned-read-");
		const projectId = "test-project";

		try {
			await withTemporaryEnv({ home: tempHome }, async () => {
				const pinnedPath = getProjectPinnedBranchesPath(projectId);
				mkdirSync(join(tempHome, ".quarterdeck", "projects", projectId), { recursive: true });
				writeFileSync(pinnedPath, JSON.stringify(["main", "develop"]));

				const state = await loadRuntimeConfig(projectId);
				expect(state.pinnedBranches).toEqual(["main", "develop"]);
			});
		} finally {
			cleanupHome();
		}
	});

	it("writes pinned branches to project directory via updateRuntimeConfig", async () => {
		const { path: tempHome, cleanup: cleanupHome } = createTempDir("quarterdeck-home-pinned-write-");
		const projectId = "test-project";

		try {
			await withTemporaryEnv({ home: tempHome }, async () => {
				mkdirSync(join(tempHome, ".quarterdeck", "projects", projectId), { recursive: true });

				const updated = await updateRuntimeConfig(projectId, {
					pinnedBranches: ["main", "feature-1"],
				});
				expect(updated.pinnedBranches).toEqual(["main", "feature-1"]);

				const pinnedPath = getProjectPinnedBranchesPath(projectId);
				const onDisk = JSON.parse(readFileSync(pinnedPath, "utf8")) as string[];
				expect(onDisk).toEqual(["main", "feature-1"]);

				const projectConfigPath = join(tempHome, ".quarterdeck", "projects", projectId, "config.json");
				expect(existsSync(projectConfigPath)).toBe(false);
			});
		} finally {
			cleanupHome();
		}
	});

	it("returns empty pinned branches when projectId is null", async () => {
		const { path: tempHome, cleanup: cleanupHome } = createTempDir("quarterdeck-home-pinned-null-");

		try {
			await withTemporaryEnv({ home: tempHome }, async () => {
				const state = await loadRuntimeConfig(null);
				expect(state.pinnedBranches).toEqual([]);
			});
		} finally {
			cleanupHome();
		}
	});

	it("removes pinned-branches.json when all branches are unpinned", async () => {
		const { path: tempHome, cleanup: cleanupHome } = createTempDir("quarterdeck-home-pinned-remove-");
		const projectId = "test-project";

		try {
			await withTemporaryEnv({ home: tempHome }, async () => {
				const pinnedPath = getProjectPinnedBranchesPath(projectId);
				mkdirSync(join(tempHome, ".quarterdeck", "projects", projectId), { recursive: true });
				writeFileSync(pinnedPath, JSON.stringify(["main"]));

				await updateRuntimeConfig(projectId, { pinnedBranches: [] });
				expect(existsSync(pinnedPath)).toBe(false);
			});
		} finally {
			cleanupHome();
		}
	});
});
