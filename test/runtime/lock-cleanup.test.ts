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

vi.mock("../../src/state/project-state", () => ({
	getRuntimeHomePath: () => mockRuntimeHome.path,
	getProjectsRootPath: () => join(mockRuntimeHome.path, "projects"),
}));

vi.mock("../../src/workdir/git-utils", () => ({
	getGitCommonDir: async (repoPath: string) => join(repoPath, ".git"),
	getGitDir: async (cwd: string) => join(cwd, ".git"),
}));

vi.mock("proper-lockfile", () => ({
	lock: vi.fn(async () => async () => {}),
}));

import {
	cleanStaleGitIndexLocks,
	cleanupGlobalStaleLockArtifacts,
	cleanupProjectStaleLockArtifacts,
} from "../../src/fs/lock-cleanup";

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

	it("removes stale artifacts from projects root and subdirectories", async () => {
		const projectsRoot = join(mockRuntimeHome.path, "projects");
		mkdirSync(projectsRoot);

		// Stale lock in projects root
		createStaleDir(projectsRoot, "index.json.lock");

		// Project subdirectory with stale temp files
		const wsDir = join(projectsRoot, "ws-abc");
		mkdirSync(wsDir);
		writeFileSync(join(wsDir, "board.json"), "{}");
		createStaleFile(wsDir, "board.json.tmp.1.2.uuid");

		await cleanupGlobalStaleLockArtifacts();

		expect(readdirSync(projectsRoot)).toEqual(["ws-abc"]);
		expect(readdirSync(wsDir)).toEqual(["board.json"]);
	});

	it("invokes the warn callback for each removed artifact", async () => {
		createStaleDir(mockRuntimeHome.path, "config.json.lock");

		const warnings: string[] = [];
		await cleanupGlobalStaleLockArtifacts((msg) => warnings.push(msg));

		expect(warnings).toHaveLength(1);
		expect(warnings[0]).toContain("config.json.lock");
	});

	it("handles nonexistent projects directory gracefully", async () => {
		// Don't create the projects directory — should not throw
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

	it("does not scan project .quarterdeck/ directory (project config lives in state home)", async () => {
		const projectQdDir = join(mockProjectRepo.path, ".quarterdeck");
		mkdirSync(projectQdDir);
		writeFileSync(join(projectQdDir, "config.json"), "{}");
		createStaleDir(projectQdDir, "config.json.lock");
		createStaleFile(projectQdDir, "config.json.tmp.1.2.uuid");

		await cleanupProjectStaleLockArtifacts([mockProjectRepo.path]);

		expect(readdirSync(projectQdDir).sort()).toEqual(["config.json", "config.json.lock", "config.json.tmp.1.2.uuid"]);
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

		const warnings: string[] = [];
		await cleanupProjectStaleLockArtifacts([mockProjectRepo.path], (msg) => warnings.push(msg));

		expect(warnings).toHaveLength(1);
		expect(warnings[0]).toContain("quarterdeck-task-worktree-setup.lock");
	});

	it("handles empty project list", async () => {
		await expect(cleanupProjectStaleLockArtifacts([])).resolves.toBeUndefined();
	});
});

describe("cleanStaleGitIndexLocks", () => {
	beforeEach(() => {
		mockRuntimeHome = createTempDir("quarterdeck-lock-cleanup-global-");
		mockProjectRepo = createTempDir("quarterdeck-lock-cleanup-project-");
	});

	afterEach(() => {
		mockRuntimeHome.cleanup();
		mockProjectRepo.cleanup();
	});

	it("removes stale index.lock from the main .git/ directory", async () => {
		const gitDir = join(mockProjectRepo.path, ".git");
		mkdirSync(gitDir);
		createStaleFile(gitDir, "index.lock");
		writeFileSync(join(gitDir, "HEAD"), "ref: refs/heads/main");

		await cleanStaleGitIndexLocks([mockProjectRepo.path]);

		expect(readdirSync(gitDir).sort()).toEqual(["HEAD"]);
	});

	it("removes stale index.lock from per-worktree git directories", async () => {
		const gitDir = join(mockProjectRepo.path, ".git");
		mkdirSync(gitDir);

		const worktreesDir = join(gitDir, "worktrees");
		const wt1Dir = join(worktreesDir, "task-alpha");
		const wt2Dir = join(worktreesDir, "task-beta");
		mkdirSync(wt1Dir, { recursive: true });
		mkdirSync(wt2Dir, { recursive: true });

		createStaleFile(wt1Dir, "index.lock");
		createStaleFile(wt2Dir, "index.lock");
		writeFileSync(join(wt1Dir, "HEAD"), "abc123");
		writeFileSync(join(wt2Dir, "HEAD"), "def456");

		await cleanStaleGitIndexLocks([mockProjectRepo.path]);

		expect(readdirSync(wt1Dir).sort()).toEqual(["HEAD"]);
		expect(readdirSync(wt2Dir).sort()).toEqual(["HEAD"]);
	});

	it("preserves fresh (non-stale) index.lock files", async () => {
		const gitDir = join(mockProjectRepo.path, ".git");
		mkdirSync(gitDir);

		// Create a fresh lock — mtime is now, so it should be preserved.
		writeFileSync(join(gitDir, "index.lock"), "");

		await cleanStaleGitIndexLocks([mockProjectRepo.path]);

		expect(readdirSync(gitDir)).toContain("index.lock");
	});

	it("does not remove non-index.lock files from worktree dirs", async () => {
		const gitDir = join(mockProjectRepo.path, ".git");
		const wtDir = join(gitDir, "worktrees", "task-gamma");
		mkdirSync(wtDir, { recursive: true });

		writeFileSync(join(wtDir, "HEAD"), "abc123");
		writeFileSync(join(wtDir, "ORIG_HEAD"), "def456");
		createStaleFile(wtDir, "index.lock");

		await cleanStaleGitIndexLocks([mockProjectRepo.path]);

		expect(readdirSync(wtDir).sort()).toEqual(["HEAD", "ORIG_HEAD"]);
	});

	it("invokes warn callback for each removed stale lock", async () => {
		const gitDir = join(mockProjectRepo.path, ".git");
		const wtDir = join(gitDir, "worktrees", "task-delta");
		mkdirSync(wtDir, { recursive: true });

		createStaleFile(gitDir, "index.lock");
		createStaleFile(wtDir, "index.lock");

		const warnings: string[] = [];
		await cleanStaleGitIndexLocks([mockProjectRepo.path], (msg) => warnings.push(msg));

		expect(warnings).toHaveLength(2);
		expect(warnings.every((w) => w.includes("index.lock"))).toBe(true);
	});

	it("handles repos with no worktrees directory", async () => {
		const gitDir = join(mockProjectRepo.path, ".git");
		mkdirSync(gitDir);

		// No .git/worktrees/ at all — should not throw.
		await expect(cleanStaleGitIndexLocks([mockProjectRepo.path])).resolves.toBeUndefined();
	});

	it("handles nonexistent repo paths gracefully", async () => {
		await expect(cleanStaleGitIndexLocks(["/nonexistent/repo"])).resolves.toBeUndefined();
	});

	it("deduplicates repos sharing the same git common dir", async () => {
		const gitDir = join(mockProjectRepo.path, ".git");
		const wtDir = join(gitDir, "worktrees", "task-echo");
		mkdirSync(wtDir, { recursive: true });

		createStaleFile(wtDir, "index.lock");

		const warnings: string[] = [];
		// Pass the same repo path twice — should only produce one warning.
		await cleanStaleGitIndexLocks([mockProjectRepo.path, mockProjectRepo.path], (msg) => warnings.push(msg));

		expect(warnings).toHaveLength(1);
	});

	it("is also called as part of cleanupProjectStaleLockArtifacts", async () => {
		const gitDir = join(mockProjectRepo.path, ".git");
		const wtDir = join(gitDir, "worktrees", "task-foxtrot");
		mkdirSync(wtDir, { recursive: true });

		createStaleFile(wtDir, "index.lock");
		writeFileSync(join(wtDir, "HEAD"), "abc123");

		const warnings: string[] = [];
		await cleanupProjectStaleLockArtifacts([mockProjectRepo.path], (msg) => warnings.push(msg));

		// The worktree's index.lock should have been cleaned up.
		expect(readdirSync(wtDir).sort()).toEqual(["HEAD"]);
		expect(warnings.some((w) => w.includes("index.lock"))).toBe(true);
	});
});
