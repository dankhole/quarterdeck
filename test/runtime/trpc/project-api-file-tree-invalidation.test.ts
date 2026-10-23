import { mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { TaskResourceOperationCoordinator } from "../../../src/core";
import { createConflictOps } from "../../../src/trpc/project-api-conflict";
import { createGitOps } from "../../../src/trpc/project-api-git-ops";
import type * as ProjectApiShared from "../../../src/trpc/project-api-shared";
import type { ProjectApiContext } from "../../../src/trpc/project-api-shared";
import { createStagingOps } from "../../../src/trpc/project-api-staging";
import { invalidateWorkdirFileListCache, listAllWorkdirFiles } from "../../../src/workdir/search-workdir-files";
import type * as TaskWorktree from "../../../src/workdir/task-worktree";
import { commitAll, initGitRepository, runGit } from "../../utilities/git-env";
import { useProcessTestBudget } from "../../utilities/process-test-budget";
import { createTempDir } from "../../utilities/temp-dir";

const mocks = vi.hoisted(() => ({ resolveTaskWorkingDirectory: vi.fn() }));
vi.mock("../../../src/workdir/task-worktree", async (importOriginal) => ({
	...(await importOriginal<typeof TaskWorktree>()),
	resolveTaskWorkingDirectory: mocks.resolveTaskWorkingDirectory,
}));
vi.mock("../../../src/trpc/project-api-shared", async (importOriginal) => ({
	...(await importOriginal<typeof ProjectApiShared>()),
	hasActiveSharedCheckoutTask: vi.fn(async () => false),
	hasSharedCheckoutBranchSwitchBlocker: vi.fn(async () => false),
}));

useProcessTestBudget();

const ctx: ProjectApiContext = {
	deps: {
		terminals: {
			getTerminalManagerForProject: vi.fn(() => null),
			ensureTerminalManagerForProject: vi.fn(),
		},
		broadcaster: {
			broadcastRuntimeProjectStateUpdated: vi.fn(),
			broadcastRuntimeProjectNotificationsUpdated: vi.fn(),
			broadcastRuntimeProjectsUpdated: vi.fn(),
			broadcastTaskTitleUpdated: vi.fn(),
			setFocusedTask: vi.fn(),
			setDocumentVisible: vi.fn(),
			requestTaskRefresh: vi.fn(),
			requestHomeRefresh: vi.fn(),
		},
		data: { buildProjectStateSnapshot: vi.fn() },
		taskResourceOperations: new TaskResourceOperationCoordinator(),
	},
	applyEffects: vi.fn(),
};
const git = createGitOps(ctx);
const staging = createStagingOps(ctx);
const conflict = createConflictOps(ctx);
const taskScope = { taskId: "task-1", baseRef: "main" };
let temp: ReturnType<typeof createTempDir>;
let home: string;
let task: string;
let featureCommit: string;
let scope: { projectId: string; projectPath: string };

beforeEach(() => {
	temp = createTempDir("quarterdeck-api-file-tree-");
	// Git reports canonical worktree paths. Alias snapshots intentionally retain
	// the cache's existing normalized-lexical identity and bounded TTL.
	const root = realpathSync(temp.path);
	home = join(root, "home");
	task = join(root, "task");
	mkdirSync(home);
	initGitRepository(home);
	writeFileSync(join(home, "base.txt"), "base\n", "utf8");
	commitAll(home, "base");
	runGit(home, ["switch", "-c", "feature"]);
	writeFileSync(join(home, "feature.txt"), "feature\n", "utf8");
	featureCommit = commitAll(home, "feature file");
	runGit(home, ["switch", "main"]);
	runGit(home, ["worktree", "add", "-b", "task", task, "main"]);
	mocks.resolveTaskWorkingDirectory.mockResolvedValue(task);
	scope = { projectId: "project-1", projectPath: home };
});

afterEach(async () => {
	invalidateWorkdirFileListCache(home);
	invalidateWorkdirFileListCache(task);
	await temp.cleanupAsync();
});

describe("project Git operations invalidate warm file listings", () => {
	it.each(["home", "task"] as const)("refreshes only the affected %s checkout", async (target) => {
		const cwd = target === "home" ? home : task;
		const other = target === "home" ? task : home;
		expect(await listAllWorkdirFiles(cwd)).not.toContain("feature.txt");
		await listAllWorkdirFiles(other);
		writeFileSync(join(other, "external.txt"), "external\n", "utf8");

		const result = await git.checkoutGitBranch(scope, {
			branch: "feature",
			...(target === "task" ? { taskId: taskScope.taskId, baseRef: "main" } : {}),
		});

		expect(result.ok).toBe(true);
		expect(await listAllWorkdirFiles(cwd)).toContain("feature.txt");
		expect(await listAllWorkdirFiles(other)).not.toContain("external.txt");
	});

	it.each(["push", "apply", "pop"] as const)("refreshes the task listing after stash %s", async (action) => {
		writeFileSync(join(task, "draft.txt"), "draft\n", "utf8");
		if (action !== "push") runGit(task, ["stash", "push", "--include-untracked"]);
		expect((await listAllWorkdirFiles(task)).includes("draft.txt")).toBe(action === "push");

		const result =
			action === "push"
				? await staging.stashPush(scope, { taskScope, paths: [] })
				: action === "apply"
					? await staging.stashApply(scope, { taskScope, index: 0 })
					: await staging.stashPop(scope, { taskScope, index: 0 });

		expect(result.ok).toBe(true);
		expect((await listAllWorkdirFiles(task)).includes("draft.txt")).toBe(action !== "push");
	});

	it("refreshes the task listing after a partially applied conflicted stash", async () => {
		writeFileSync(join(task, "base.txt"), "stashed version\n", "utf8");
		writeFileSync(join(task, "draft.txt"), "draft\n", "utf8");
		runGit(task, ["stash", "push", "--include-untracked"]);
		writeFileSync(join(task, "base.txt"), "committed version\n", "utf8");
		commitAll(task, "conflicting task change");
		expect(await listAllWorkdirFiles(task)).not.toContain("draft.txt");

		const result = await staging.stashApply(scope, { taskScope, index: 0 });

		expect(result.ok).toBe(false);
		expect(result.conflicted).toBe(true);
		expect(await listAllWorkdirFiles(task)).toContain("draft.txt");
	});

	it.each(["file", "all"] as const)("refreshes a listing after discarding %s changes", async (kind) => {
		const cwd = kind === "file" ? home : task;
		writeFileSync(join(cwd, "draft.txt"), "draft\n", "utf8");
		expect(await listAllWorkdirFiles(cwd)).toContain("draft.txt");

		const result =
			kind === "file"
				? await staging.discardFile(scope, { taskScope: null, path: "draft.txt", fileStatus: "untracked" })
				: await staging.discardGitChanges(scope, taskScope);

		expect(result.ok).toBe(true);
		expect(await listAllWorkdirFiles(cwd)).not.toContain("draft.txt");
	});

	it("refreshes the task listing after a hard reset", async () => {
		runGit(task, ["switch", "feature"]);
		expect(await listAllWorkdirFiles(task)).toContain("feature.txt");
		const result = await git.resetToRef(scope, { ...taskScope, ref: "main" });
		expect(result.ok).toBe(true);
		expect(await listAllWorkdirFiles(task)).not.toContain("feature.txt");
	});

	it("refreshes the task listing after a rebase", async () => {
		expect(await listAllWorkdirFiles(task)).not.toContain("feature.txt");
		const result = await git.rebaseBranch(scope, { ...taskScope, onto: "feature" });
		expect(result.ok).toBe(true);
		expect(await listAllWorkdirFiles(task)).toContain("feature.txt");
	});

	it("refreshes the target worktree rather than the source cwd after cherry-pick", async () => {
		await listAllWorkdirFiles(home);
		expect(await listAllWorkdirFiles(task)).not.toContain("feature.txt");
		writeFileSync(join(home, "external.txt"), "external\n", "utf8");

		const result = await git.cherryPickCommit(scope, { commitHash: featureCommit, targetBranch: "task" });

		expect(result.ok).toBe(true);
		expect(await listAllWorkdirFiles(task)).toContain("feature.txt");
		expect(await listAllWorkdirFiles(home)).not.toContain("external.txt");
	});

	it("refreshes the home listing after revert", async () => {
		runGit(home, ["switch", "feature"]);
		expect(await listAllWorkdirFiles(home)).toContain("feature.txt");

		const result = await git.revertCommit(scope, {
			commitHash: featureCommit,
			expectedHead: featureCommit,
			expectedBranch: "feature",
		});

		expect(result.ok).toBe(true);
		expect(await listAllWorkdirFiles(home)).not.toContain("feature.txt");
	});

	it.each(["abort", "continue"] as const)("refreshes after a conflicted merge and its %s", async (action) => {
		runGit(home, ["switch", "feature"]);
		writeFileSync(join(home, "base.txt"), "feature version\n", "utf8");
		commitAll(home, "conflicting feature change");
		runGit(home, ["switch", "main"]);
		writeFileSync(join(home, "base.txt"), "main version\n", "utf8");
		commitAll(home, "conflicting main change");
		expect(await listAllWorkdirFiles(home)).not.toContain("feature.txt");

		const merged = await git.mergeBranch(scope, { branch: "feature" });

		expect(merged.ok).toBe(false);
		expect(merged.conflictState).toBeDefined();
		expect(await listAllWorkdirFiles(home)).toContain("feature.txt");
		if (action === "abort") {
			const result = await conflict.abortConflictResolution(scope, {});
			expect(result.ok).toBe(true);
			expect(await listAllWorkdirFiles(home)).not.toContain("feature.txt");
		} else {
			const resolved = await conflict.resolveConflictFile(scope, { path: "base.txt", resolution: "ours" });
			expect(resolved.ok).toBe(true);
			await listAllWorkdirFiles(home);
			writeFileSync(join(home, "external.txt"), "external\n", "utf8");
			const result = await conflict.continueConflictResolution(scope, {});
			expect(result.ok).toBe(true);
			expect(await listAllWorkdirFiles(home)).toContain("external.txt");
		}
	});

	it("refreshes the home listing after pulling the checked-out branch", async () => {
		const remote = join(realpathSync(temp.path), "origin.git");
		runGit(home, ["init", "--bare", remote]);
		runGit(home, ["remote", "add", "origin", remote]);
		runGit(home, ["push", "-u", "origin", "main", "feature"]);
		runGit(remote, ["update-ref", "refs/heads/main", featureCommit]);
		expect(await listAllWorkdirFiles(home)).not.toContain("feature.txt");

		const result = await git.runGitSyncAction(scope, { action: "pull" });

		expect(result.ok).toBe(true);
		expect(await listAllWorkdirFiles(home)).toContain("feature.txt");
	});

	it("preserves warm snapshots for read-only, fetch, push-only, and stash-metadata operations", async () => {
		writeFileSync(join(home, "draft.txt"), "draft\n", "utf8");
		runGit(home, ["stash", "push", "--include-untracked"]);
		await listAllWorkdirFiles(home);
		writeFileSync(join(home, "external.txt"), "external\n", "utf8");

		await staging.stashList(scope, { taskScope: null });
		await staging.stashShow(scope, { taskScope: null, index: 0 });
		await staging.stashDrop(scope, { taskScope: null, index: 0 });
		await git.runGitSyncAction(scope, { action: "fetch" });
		await git.runGitSyncAction(scope, { action: "push" });
		await git.runGitSyncAction(scope, { action: "pull", branch: "feature" });

		expect(await listAllWorkdirFiles(home)).not.toContain("external.txt");
	});
});
