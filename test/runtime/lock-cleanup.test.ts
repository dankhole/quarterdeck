import { mkdirSync, readdirSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createTempDir } from "../utilities/temp-dir";

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

/** Temp dir representing ~/.quarterdeck/ */
let mockRuntimeHome: ReturnType<typeof createTempDir>;

/** Temp dir representing a project repo */
let mockProjectRepo: ReturnType<typeof createTempDir>;

vi.mock("../../src/state/workspace-state", () => ({
	getRuntimeHomePath: () => mockRuntimeHome.path,
	getWorkspacesRootPath: () => join(mockRuntimeHome.path, "workspaces"),
}));

vi.mock("../../src/workspace/git-utils", () => ({
	getGitCommonDir: async (repoPath: string) => join(repoPath, ".git"),
}));

vi.mock("proper-lockfile", () => ({
	lock: vi.fn(async () => async () => {}),
}));

import { cleanupGlobalStaleLockArtifacts, cleanupProjectStaleLockArtifacts } from "../../src/fs/lock-cleanup";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Backdate an entry's mtime to 30 seconds ago so it's clearly stale. */
function makeStale(path: string): void {
	const oldTime = new Date(Date.now() - 30_000);
	utimesSync(path, oldTime, oldTime);
}

function createStaleDir(parentDir: string, name: string): string {
	const p = join(parentDir, name);
	mkdirSync(p, { recursive: true });
	makeStale(p);
	return p;
}

function createStaleFile(parentDir: string, name: string): string {
	const p = join(parentDir, name);
	writeFileSync(p, "partial");
	makeStale(p);
	return p;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("cleanupGlobalStaleLockArtifacts (phase 1)", () => {
	beforeEach(() => {
		mockRuntimeHome = createTempDir("quarterdeck-lock-cleanup-global-");
	});

	afterEach(() => {
		mockRuntimeHome.cleanup();
	});

	it("removes stale .lock dirs and .tmp files from the runtime home", async () => {
		writeFileSync(join(mockRuntimeHome.path, "config.json"), "{}");
		createStaleDir(mockRuntimeHome.path, "config.json.lock");
		createStaleFile(mockRuntimeHome.path, "config.json.tmp.1.2.uuid");

		await cleanupGlobalStaleLockArtifacts();

		expect(readdirSync(mockRuntimeHome.path)).toEqual(["config.json"]);
	});

	it("removes stale artifacts from workspaces root and subdirectories", async () => {
		const workspacesRoot = join(mockRuntimeHome.path, "workspaces");
		mkdirSync(workspacesRoot);

		// Stale lock in workspaces root
		createStaleDir(workspacesRoot, "index.json.lock");

		// Workspace subdirectory with stale temp files
		const wsDir = join(workspacesRoot, "ws-abc");
		mkdirSync(wsDir);
		writeFileSync(join(wsDir, "board.json"), "{}");
		createStaleFile(wsDir, "board.json.tmp.1.2.uuid");

		await cleanupGlobalStaleLockArtifacts();

		expect(readdirSync(workspacesRoot)).toEqual(["ws-abc"]);
		expect(readdirSync(wsDir)).toEqual(["board.json"]);
	});

	it("invokes the warn callback for each removed artifact", async () => {
		createStaleDir(mockRuntimeHome.path, "config.json.lock");

		const warnings: string[] = [];
		await cleanupGlobalStaleLockArtifacts((msg) => warnings.push(msg));

		expect(warnings).toHaveLength(1);
		expect(warnings[0]).toContain("config.json.lock");
	});

	it("handles nonexistent workspaces directory gracefully", async () => {
		// Don't create the workspaces directory — should not throw
		await expect(cleanupGlobalStaleLockArtifacts()).resolves.toBeUndefined();
	});
});

describe("cleanupProjectStaleLockArtifacts (phase 2)", () => {
	beforeEach(() => {
		mockRuntimeHome = createTempDir("quarterdeck-lock-cleanup-global-");
		mockProjectRepo = createTempDir("quarterdeck-lock-cleanup-project-");
	});

	afterEach(() => {
		mockRuntimeHome.cleanup();
		mockProjectRepo.cleanup();
	});

	it("removes stale artifacts from project .quarterdeck/ directory (broad scan)", async () => {
		const projectQdDir = join(mockProjectRepo.path, ".quarterdeck");
		mkdirSync(projectQdDir);
		writeFileSync(join(projectQdDir, "config.json"), "{}");
		createStaleDir(projectQdDir, "config.json.lock");
		createStaleFile(projectQdDir, "config.json.tmp.1.2.uuid");

		await cleanupProjectStaleLockArtifacts([mockProjectRepo.path]);

		expect(readdirSync(projectQdDir).sort()).toEqual(["config.json"]);
	});

	it("removes the stale quarterdeck worktree setup lock from .git/ directory", async () => {
		const gitDir = join(mockProjectRepo.path, ".git");
		mkdirSync(gitDir);

		createStaleDir(gitDir, "quarterdeck-task-worktree-setup.lock");

		await cleanupProjectStaleLockArtifacts([mockProjectRepo.path]);

		expect(readdirSync(gitDir)).toEqual([]);
	});

	it("does NOT remove non-Quarterdeck lock files from .git/ (targeted mode)", async () => {
		const gitDir = join(mockProjectRepo.path, ".git");
		mkdirSync(gitDir);

		// Git's own lock files — these must be preserved
		createStaleDir(gitDir, "index.lock");
		createStaleFile(gitDir, "config.lock");
		writeFileSync(join(gitDir, "HEAD"), "ref: refs/heads/main");

		// Quarterdeck lock — this should be removed
		createStaleDir(gitDir, "quarterdeck-task-worktree-setup.lock");

		await cleanupProjectStaleLockArtifacts([mockProjectRepo.path]);

		const remaining = readdirSync(gitDir).sort();
		expect(remaining).toEqual(["HEAD", "config.lock", "index.lock"]);
	});

	it("preserves fresh (non-stale) Quarterdeck lock artifacts in .git/", async () => {
		const gitDir = join(mockProjectRepo.path, ".git");
		mkdirSync(gitDir);

		// Create a fresh lock (not stale — mtime is recent)
		mkdirSync(join(gitDir, "quarterdeck-task-worktree-setup.lock"));

		await cleanupProjectStaleLockArtifacts([mockProjectRepo.path]);

		expect(readdirSync(gitDir)).toEqual(["quarterdeck-task-worktree-setup.lock"]);
	});

	it("handles multiple projects", async () => {
		const projectB = createTempDir("quarterdeck-lock-cleanup-project-b-");
		try {
			const gitDirA = join(mockProjectRepo.path, ".git");
			const gitDirB = join(projectB.path, ".git");
			mkdirSync(gitDirA);
			mkdirSync(gitDirB);

			createStaleDir(gitDirA, "quarterdeck-task-worktree-setup.lock");
			createStaleDir(gitDirB, "quarterdeck-task-worktree-setup.lock");

			await cleanupProjectStaleLockArtifacts([mockProjectRepo.path, projectB.path]);

			expect(readdirSync(gitDirA)).toEqual([]);
			expect(readdirSync(gitDirB)).toEqual([]);
		} finally {
			projectB.cleanup();
		}
	});

	it("skips projects whose directories no longer exist", async () => {
		await expect(cleanupProjectStaleLockArtifacts(["/nonexistent/project/path"])).resolves.toBeUndefined();
	});

	it("invokes the warn callback for removed project artifacts", async () => {
		const gitDir = join(mockProjectRepo.path, ".git");
		mkdirSync(gitDir);
		createStaleDir(gitDir, "quarterdeck-task-worktree-setup.lock");

		const projectQdDir = join(mockProjectRepo.path, ".quarterdeck");
		mkdirSync(projectQdDir);
		createStaleDir(projectQdDir, "config.json.lock");

		const warnings: string[] = [];
		await cleanupProjectStaleLockArtifacts([mockProjectRepo.path], (msg) => warnings.push(msg));

		expect(warnings).toHaveLength(2);
		const joined = warnings.join("\n");
		expect(joined).toContain("quarterdeck-task-worktree-setup.lock");
		expect(joined).toContain("config.json.lock");
	});

	it("handles empty project list", async () => {
		await expect(cleanupProjectStaleLockArtifacts([])).resolves.toBeUndefined();
	});
});
