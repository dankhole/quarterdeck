import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { loadRuntimeConfig, updateRuntimeConfig } from "../../../src/config/runtime-config";
import { getWorkspacePinnedBranchesPath } from "../../../src/state/workspace-state-utils";
import { createTempDir } from "../../utilities/temp-dir";
import { withTemporaryEnv } from "./runtime-config-helpers";

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
				const projectConfigDir = join(tempProject, ".quarterdeck");
				mkdirSync(projectConfigDir, { recursive: true });
				writeFileSync(join(projectConfigDir, "config.json"), JSON.stringify({ pinnedBranches: ["old-branch"] }));

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
