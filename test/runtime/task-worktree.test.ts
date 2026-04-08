import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createTempDir } from "../utilities/temp-dir";

const childProcessMocks = vi.hoisted(() => ({
	execFile: vi.fn(),
	execFilePromise: vi.fn(),
}));

const lockedFileSystemMocks = vi.hoisted(() => ({
	withLock: vi.fn(),
	writeTextFileAtomic: vi.fn(),
}));

const workspaceStateMocks = vi.hoisted(() => ({
	getRuntimeHomePath: vi.fn(),
	getTaskWorktreesHomePath: vi.fn(),
	loadWorkspaceContext: vi.fn(),
}));

const taskWorktreePathMocks = vi.hoisted(() => ({
	getWorkspaceFolderLabelForWorktreePath: vi.fn(),
	normalizeTaskIdForWorktreePath: vi.fn(),
}));

vi.mock("node:child_process", () => ({
	execFile: Object.assign(childProcessMocks.execFile, {
		[promisify.custom]: childProcessMocks.execFilePromise,
	}),
}));

vi.mock("../../src/fs/locked-file-system.js", () => ({
	lockedFileSystem: {
		withLock: lockedFileSystemMocks.withLock,
		writeTextFileAtomic: lockedFileSystemMocks.writeTextFileAtomic,
	},
}));

vi.mock("../../src/state/workspace-state.js", () => ({
	getRuntimeHomePath: workspaceStateMocks.getRuntimeHomePath,
	getTaskWorktreesHomePath: workspaceStateMocks.getTaskWorktreesHomePath,
	loadWorkspaceContext: workspaceStateMocks.loadWorkspaceContext,
}));

vi.mock("../../src/workspace/task-worktree-path.js", () => ({
	getWorkspaceFolderLabelForWorktreePath: taskWorktreePathMocks.getWorkspaceFolderLabelForWorktreePath,
	QUARTERDECK_TASK_WORKTREES_DIR_NAME: "worktrees",
	normalizeTaskIdForWorktreePath: taskWorktreePathMocks.normalizeTaskIdForWorktreePath,
}));

import { ensureTaskWorktreeIfDoesntExist } from "../../src/workspace/task-worktree";

type ExecFileOptions = {
	cwd?: string;
	encoding?: string;
	maxBuffer?: number;
	env?: NodeJS.ProcessEnv;
};

function createGitError(message: string): NodeJS.ErrnoException & { stdout: string; stderr: string; code: number } {
	const error = new Error(message) as NodeJS.ErrnoException & { stdout: string; stderr: string };
	Object.assign(error, {
		code: 1,
		stdout: "",
		stderr: message,
	});
	return error as NodeJS.ErrnoException & { stdout: string; stderr: string; code: number };
}

function stripConfigFlags(args: readonly string[]): string[] {
	const result: string[] = [];
	for (let i = 0; i < args.length; i++) {
		if (args[i] === "-c" && i + 1 < args.length) {
			i += 1;
			continue;
		}
		result.push(args[i] as string);
	}
	return result;
}

function getCommandArgs(args: readonly string[], options?: ExecFileOptions): { cwd: string; command: string[] } {
	const cleaned = stripConfigFlags(args);
	if (cleaned[0] === "-C" && typeof cleaned[1] === "string") {
		return {
			cwd: cleaned[1],
			command: cleaned.slice(2),
		};
	}
	if (typeof options?.cwd === "string") {
		return {
			cwd: options.cwd,
			command: cleaned,
		};
	}
	throw new Error(`Unexpected git args: ${args.join(" ")}`);
}

describe.sequential("task-worktree serialization", () => {
	beforeEach(() => {
		childProcessMocks.execFile.mockReset();
		childProcessMocks.execFilePromise.mockReset();
		lockedFileSystemMocks.withLock.mockReset();
		lockedFileSystemMocks.writeTextFileAtomic.mockReset();
		workspaceStateMocks.getRuntimeHomePath.mockReset();
		workspaceStateMocks.getTaskWorktreesHomePath.mockReset();
		workspaceStateMocks.loadWorkspaceContext.mockReset();
		taskWorktreePathMocks.getWorkspaceFolderLabelForWorktreePath.mockReset();
		taskWorktreePathMocks.normalizeTaskIdForWorktreePath.mockReset();

		let lockQueue = Promise.resolve();
		lockedFileSystemMocks.withLock.mockImplementation(
			async (_request: unknown, operation: () => Promise<unknown>) => {
				const waitForTurn = lockQueue;
				let releaseLock: () => void = () => {};
				lockQueue = new Promise<void>((resolve) => {
					releaseLock = resolve;
				});
				await waitForTurn;
				try {
					return await operation();
				} finally {
					releaseLock();
				}
			},
		);
		lockedFileSystemMocks.writeTextFileAtomic.mockResolvedValue(undefined);
	});

	afterEach(() => {
		vi.clearAllMocks();
	});

	it("serializes submodule initialization across concurrent worktree creation", async () => {
		const { path: sandboxRoot, cleanup } = createTempDir("quarterdeck-task-worktree-lock-");
		try {
			const repoPath = join(sandboxRoot, "repo");
			const runtimeHomePath = join(sandboxRoot, "runtime-home");
			const worktreesHomePath = join(sandboxRoot, "worktrees-home");
			mkdirSync(join(repoPath, ".git"), { recursive: true });
			mkdirSync(runtimeHomePath, { recursive: true });
			mkdirSync(worktreesHomePath, { recursive: true });

			workspaceStateMocks.getRuntimeHomePath.mockReturnValue(runtimeHomePath);
			workspaceStateMocks.getTaskWorktreesHomePath.mockReturnValue(worktreesHomePath);
			workspaceStateMocks.loadWorkspaceContext.mockResolvedValue({
				repoPath,
			});
			taskWorktreePathMocks.getWorkspaceFolderLabelForWorktreePath.mockReturnValue("repo");
			taskWorktreePathMocks.normalizeTaskIdForWorktreePath.mockImplementation((taskId: string) => taskId);

			const worktreeHeads = new Map<string, string>();
			let activeSubmoduleUpdates = 0;
			let maxConcurrentSubmoduleUpdates = 0;

			childProcessMocks.execFilePromise.mockImplementation(
				async (_file: string, args: readonly string[], options?: ExecFileOptions) => {
					const { cwd, command } = getCommandArgs(args, options);

					if (command[0] === "rev-parse" && command[1] === "--git-common-dir") {
						return {
							stdout: ".git\n",
							stderr: "",
						};
					}

					if (command[0] === "rev-parse" && command[1] === "HEAD") {
						const head = worktreeHeads.get(cwd);
						if (!head) {
							throw createGitError("fatal: not a git repository");
						}
						return {
							stdout: `${head}\n`,
							stderr: "",
						};
					}

					if (command[0] === "rev-parse" && command[1] === "--verify") {
						return {
							stdout: "base-commit\n",
							stderr: "",
						};
					}

					if (command[0] === "worktree" && command[1] === "add") {
						const worktreePath = command[3];
						const commit = command[4] ?? "base-commit";
						if (!worktreePath) {
							throw createGitError("fatal: missing worktree path");
						}
						mkdirSync(worktreePath, { recursive: true });
						writeFileSync(
							join(worktreePath, ".gitmodules"),
							'[submodule "evals/quarterdeck-bench"]\n\tpath = evals/quarterdeck-bench\n\turl = ../quarterdeck-bench\n',
							"utf8",
						);
						worktreeHeads.set(worktreePath, commit);
						return {
							stdout: "",
							stderr: "",
						};
					}

					if (command[0] === "config" && command[1] === "--file") {
						return {
							stdout: "submodule.evals/quarterdeck-bench.path evals/quarterdeck-bench\n",
							stderr: "",
						};
					}

					if (command[0] === "submodule" && command[1] === "update") {
						activeSubmoduleUpdates += 1;
						maxConcurrentSubmoduleUpdates = Math.max(maxConcurrentSubmoduleUpdates, activeSubmoduleUpdates);
						await new Promise((resolve) => {
							setTimeout(resolve, 25);
						});
						mkdirSync(join(cwd, "evals", "quarterdeck-bench"), { recursive: true });
						writeFileSync(join(cwd, "evals", "quarterdeck-bench", ".git"), "gitdir: fake\n", "utf8");
						activeSubmoduleUpdates -= 1;
						return {
							stdout: "",
							stderr: "",
						};
					}

					if (command[0] === "ls-files") {
						return {
							stdout: "",
							stderr: "",
						};
					}

					if (command[0] === "rev-parse" && command[1] === "--git-path") {
						return {
							stdout: ".git/info/exclude\n",
							stderr: "",
						};
					}

					throw createGitError(`Unhandled git command: ${command.join(" ")}`);
				},
			);

			const [first, second] = await Promise.all([
				ensureTaskWorktreeIfDoesntExist({
					cwd: repoPath,
					taskId: "task-a",
					baseRef: "HEAD",
				}),
				ensureTaskWorktreeIfDoesntExist({
					cwd: repoPath,
					taskId: "task-b",
					baseRef: "HEAD",
				}),
			]);

			const firstLockRequest = lockedFileSystemMocks.withLock.mock.calls[0]?.[0] as {
				path: string;
				type: string;
				lockfileName: string;
			};
			expect(first, JSON.stringify(first, null, 2)).toMatchObject({ ok: true, baseCommit: "base-commit" });
			expect(second, JSON.stringify(second, null, 2)).toMatchObject({ ok: true, baseCommit: "base-commit" });
			expect(firstLockRequest).toMatchObject({
				path: join(repoPath, ".git"),
				type: "directory",
				lockfileName: "quarterdeck-task-worktree-setup.lock",
			});
			expect(maxConcurrentSubmoduleUpdates).toBe(1);
		} finally {
			cleanup();
		}
	});
});

describe.sequential("branch-aware worktree creation", () => {
	beforeEach(() => {
		childProcessMocks.execFile.mockReset();
		childProcessMocks.execFilePromise.mockReset();
		lockedFileSystemMocks.withLock.mockReset();
		lockedFileSystemMocks.writeTextFileAtomic.mockReset();
		workspaceStateMocks.getRuntimeHomePath.mockReset();
		workspaceStateMocks.getTaskWorktreesHomePath.mockReset();
		workspaceStateMocks.loadWorkspaceContext.mockReset();
		taskWorktreePathMocks.getWorkspaceFolderLabelForWorktreePath.mockReset();
		taskWorktreePathMocks.normalizeTaskIdForWorktreePath.mockReset();

		let lockQueue = Promise.resolve();
		lockedFileSystemMocks.withLock.mockImplementation(
			async (_request: unknown, operation: () => Promise<unknown>) => {
				const waitForTurn = lockQueue;
				let releaseLock: () => void = () => {};
				lockQueue = new Promise<void>((resolve) => {
					releaseLock = resolve;
				});
				await waitForTurn;
				try {
					return await operation();
				} finally {
					releaseLock();
				}
			},
		);
		lockedFileSystemMocks.writeTextFileAtomic.mockResolvedValue(undefined);
	});

	afterEach(() => {
		vi.clearAllMocks();
	});

	function setupSandbox() {
		const { path: sandboxRoot, cleanup } = createTempDir("quarterdeck-task-worktree-branch-");
		const repoPath = join(sandboxRoot, "repo");
		const runtimeHomePath = join(sandboxRoot, "runtime-home");
		const worktreesHomePath = join(sandboxRoot, "worktrees-home");
		mkdirSync(join(repoPath, ".git"), { recursive: true });
		mkdirSync(runtimeHomePath, { recursive: true });
		mkdirSync(worktreesHomePath, { recursive: true });

		workspaceStateMocks.getRuntimeHomePath.mockReturnValue(runtimeHomePath);
		workspaceStateMocks.getTaskWorktreesHomePath.mockReturnValue(worktreesHomePath);
		workspaceStateMocks.loadWorkspaceContext.mockResolvedValue({ repoPath });
		taskWorktreePathMocks.getWorkspaceFolderLabelForWorktreePath.mockReturnValue("repo");
		taskWorktreePathMocks.normalizeTaskIdForWorktreePath.mockImplementation((taskId: string) => taskId);

		return { sandboxRoot, repoPath, runtimeHomePath, worktreesHomePath, cleanup };
	}

	function createBranchAwareMock(options: {
		worktreeHeads: Map<string, string>;
		existingBranches: Set<string>;
		failOnBranchCheckout?: Set<string>;
		failOnBranchCreate?: Set<string>;
	}) {
		const { worktreeHeads, existingBranches, failOnBranchCheckout, failOnBranchCreate } = options;

		return async (_file: string, args: readonly string[], execOptions?: ExecFileOptions) => {
			const { cwd, command } = getCommandArgs(args, execOptions);

			if (command[0] === "rev-parse" && command[1] === "--git-common-dir") {
				return { stdout: ".git\n", stderr: "" };
			}

			if (command[0] === "rev-parse" && command[1] === "HEAD") {
				const head = worktreeHeads.get(cwd);
				if (!head) {
					throw createGitError("fatal: not a git repository");
				}
				return { stdout: `${head}\n`, stderr: "" };
			}

			if (command[0] === "rev-parse" && command[1] === "--verify") {
				const ref = command[2] ?? "";
				// Branch ref check: refs/heads/<branch>
				if (ref.startsWith("refs/heads/")) {
					const branchName = ref.replace("refs/heads/", "");
					if (existingBranches.has(branchName)) {
						return { stdout: "base-commit\n", stderr: "" };
					}
					throw createGitError(`fatal: Needed a single revision\nfatal: couldn't verify ref: ${ref}`);
				}
				// Base ref resolution
				return { stdout: "base-commit\n", stderr: "" };
			}

			if (command[0] === "worktree" && command[1] === "add") {
				const isDetach = command[2] === "--detach";
				const isBranchCreate = command[2] === "-b";

				if (isBranchCreate) {
					const branchName = command[3];
					const worktreePath = command[4];
					const commit = command[5] ?? "base-commit";
					if (!worktreePath || !branchName) {
						throw createGitError("fatal: missing args");
					}
					if (failOnBranchCreate?.has(branchName)) {
						throw createGitError(`fatal: cannot create branch '${branchName}'`);
					}
					mkdirSync(worktreePath, { recursive: true });
					worktreeHeads.set(worktreePath, commit);
					existingBranches.add(branchName);
					return { stdout: "", stderr: "" };
				}

				if (isDetach) {
					const worktreePath = command[3];
					const commit = command[4] ?? "base-commit";
					if (!worktreePath) {
						throw createGitError("fatal: missing worktree path");
					}
					mkdirSync(worktreePath, { recursive: true });
					worktreeHeads.set(worktreePath, commit);
					return { stdout: "", stderr: "" };
				}

				// Named branch checkout: git worktree add <path> <branch>
				const worktreePath = command[2];
				const branchName = command[3];
				if (!worktreePath) {
					throw createGitError("fatal: missing worktree path");
				}
				if (branchName && failOnBranchCheckout?.has(branchName)) {
					// Simulate partial directory creation before failure
					mkdirSync(worktreePath, { recursive: true });
					throw createGitError(`fatal: '${branchName}' is already checked out`);
				}
				mkdirSync(worktreePath, { recursive: true });
				worktreeHeads.set(worktreePath, "base-commit");
				return { stdout: "", stderr: "" };
			}

			if (command[0] === "worktree" && command[1] === "remove") {
				const worktreePath = command[2];
				if (worktreePath) {
					try {
						rmSync(worktreePath, { recursive: true, force: true });
					} catch {}
					worktreeHeads.delete(worktreePath);
				}
				return { stdout: "", stderr: "" };
			}

			if (command[0] === "worktree" && command[1] === "prune") {
				return { stdout: "", stderr: "" };
			}

			if (command[0] === "config" && command[1] === "--file") {
				return { stdout: "", stderr: "" };
			}

			if (command[0] === "submodule" && command[1] === "update") {
				return { stdout: "", stderr: "" };
			}

			if (command[0] === "ls-files") {
				return { stdout: "", stderr: "" };
			}

			if (command[0] === "rev-parse" && command[1] === "--git-path") {
				return { stdout: ".git/info/exclude\n", stderr: "" };
			}

			throw createGitError(`Unhandled git command: ${command.join(" ")}`);
		};
	}

	it("checks out existing branch when available (test 19)", async () => {
		const { repoPath, cleanup } = setupSandbox();
		try {
			const worktreeHeads = new Map<string, string>();
			const existingBranches = new Set(["feat/test"]);

			childProcessMocks.execFilePromise.mockImplementation(
				createBranchAwareMock({ worktreeHeads, existingBranches }),
			);

			const result = await ensureTaskWorktreeIfDoesntExist({
				cwd: repoPath,
				taskId: "task-branch",
				baseRef: "HEAD",
				branch: "feat/test",
			});

			expect(result).toMatchObject({ ok: true });
			// Verify the worktree add was called with the branch name (not --detach)
			const worktreeAddCalls = childProcessMocks.execFilePromise.mock.calls.filter((_call: unknown[]) => {
				const args = stripConfigFlags(_call[1] as string[]);
				const { command } = getCommandArgs(args, _call[2] as ExecFileOptions | undefined);
				return (
					command[0] === "worktree" && command[1] === "add" && command[2] !== "--detach" && command[2] !== "-b"
				);
			});
			expect(worktreeAddCalls.length).toBeGreaterThanOrEqual(1);
		} finally {
			cleanup();
		}
	});

	it("recreates missing branch via -b (test 20)", async () => {
		const { repoPath, cleanup } = setupSandbox();
		try {
			const worktreeHeads = new Map<string, string>();
			const existingBranches = new Set<string>(); // feat/gone does NOT exist

			childProcessMocks.execFilePromise.mockImplementation(
				createBranchAwareMock({ worktreeHeads, existingBranches }),
			);

			const result = await ensureTaskWorktreeIfDoesntExist({
				cwd: repoPath,
				taskId: "task-gone",
				baseRef: "HEAD",
				branch: "feat/gone",
			});

			expect(result).toMatchObject({ ok: true });
			// Branch should have been created via -b
			expect(existingBranches.has("feat/gone")).toBe(true);
			// Verify the worktree add was called with -b
			const createCalls = childProcessMocks.execFilePromise.mock.calls.filter((_call: unknown[]) => {
				const args = stripConfigFlags(_call[1] as string[]);
				const { command } = getCommandArgs(args, _call[2] as ExecFileOptions | undefined);
				return command[0] === "worktree" && command[1] === "add" && command[2] === "-b";
			});
			expect(createCalls.length).toBeGreaterThanOrEqual(1);
		} finally {
			cleanup();
		}
	});

	it("falls back to detached HEAD when branch locked (test 21)", async () => {
		const { repoPath, cleanup } = setupSandbox();
		try {
			const worktreeHeads = new Map<string, string>();
			const existingBranches = new Set(["feat/locked"]);
			const failOnBranchCheckout = new Set(["feat/locked"]);

			childProcessMocks.execFilePromise.mockImplementation(
				createBranchAwareMock({ worktreeHeads, existingBranches, failOnBranchCheckout }),
			);

			const result = await ensureTaskWorktreeIfDoesntExist({
				cwd: repoPath,
				taskId: "task-locked",
				baseRef: "HEAD",
				branch: "feat/locked",
			});

			expect(result).toMatchObject({ ok: true });
			// Verify detached HEAD fallback was used
			const detachCalls = childProcessMocks.execFilePromise.mock.calls.filter((_call: unknown[]) => {
				const args = stripConfigFlags(_call[1] as string[]);
				const { command } = getCommandArgs(args, _call[2] as ExecFileOptions | undefined);
				return command[0] === "worktree" && command[1] === "add" && command[2] === "--detach";
			});
			expect(detachCalls.length).toBeGreaterThanOrEqual(1);
		} finally {
			cleanup();
		}
	});

	it("creates new branch with -b when branch does not exist locally (test 22)", async () => {
		const { repoPath, cleanup } = setupSandbox();
		try {
			const worktreeHeads = new Map<string, string>();
			const existingBranches = new Set<string>(); // quarterdeck/my-feature does NOT exist

			childProcessMocks.execFilePromise.mockImplementation(
				createBranchAwareMock({ worktreeHeads, existingBranches }),
			);

			const result = await ensureTaskWorktreeIfDoesntExist({
				cwd: repoPath,
				taskId: "task-new-branch",
				baseRef: "HEAD",
				branch: "quarterdeck/my-feature",
			});

			expect(result).toMatchObject({ ok: true });
			expect(existingBranches.has("quarterdeck/my-feature")).toBe(true);
		} finally {
			cleanup();
		}
	});

	it("falls back to detached when -b fails (test 23a)", async () => {
		const { repoPath, cleanup } = setupSandbox();
		try {
			const worktreeHeads = new Map<string, string>();
			const existingBranches = new Set<string>();
			const failOnBranchCreate = new Set(["quarterdeck/fail-branch"]);

			childProcessMocks.execFilePromise.mockImplementation(
				createBranchAwareMock({ worktreeHeads, existingBranches, failOnBranchCreate }),
			);

			const result = await ensureTaskWorktreeIfDoesntExist({
				cwd: repoPath,
				taskId: "task-fail-create",
				baseRef: "HEAD",
				branch: "quarterdeck/fail-branch",
			});

			expect(result).toMatchObject({ ok: true });
			// Branch should NOT have been created
			expect(existingBranches.has("quarterdeck/fail-branch")).toBe(false);
			// Verify detached HEAD fallback was used
			const detachCalls = childProcessMocks.execFilePromise.mock.calls.filter((_call: unknown[]) => {
				const args = stripConfigFlags(_call[1] as string[]);
				const { command } = getCommandArgs(args, _call[2] as ExecFileOptions | undefined);
				return command[0] === "worktree" && command[1] === "add" && command[2] === "--detach";
			});
			expect(detachCalls.length).toBeGreaterThanOrEqual(1);
		} finally {
			cleanup();
		}
	});

	it("falls back to detached when existing branch checkout fails (test 23b)", async () => {
		const { repoPath, cleanup } = setupSandbox();
		try {
			const worktreeHeads = new Map<string, string>();
			const existingBranches = new Set(["feat/locked"]);
			const failOnBranchCheckout = new Set(["feat/locked"]);

			childProcessMocks.execFilePromise.mockImplementation(
				createBranchAwareMock({ worktreeHeads, existingBranches, failOnBranchCheckout }),
			);

			const result = await ensureTaskWorktreeIfDoesntExist({
				cwd: repoPath,
				taskId: "task-checkout-fail",
				baseRef: "HEAD",
				branch: "feat/locked",
			});

			expect(result).toMatchObject({ ok: true });
			// Should have fallen back to detached
			const detachCalls = childProcessMocks.execFilePromise.mock.calls.filter((_call: unknown[]) => {
				const args = stripConfigFlags(_call[1] as string[]);
				const { command } = getCommandArgs(args, _call[2] as ExecFileOptions | undefined);
				return command[0] === "worktree" && command[1] === "add" && command[2] === "--detach";
			});
			expect(detachCalls.length).toBeGreaterThanOrEqual(1);
			// Cleanup calls should have happened (worktree remove + prune)
			const removeCalls = childProcessMocks.execFilePromise.mock.calls.filter((_call: unknown[]) => {
				const args = stripConfigFlags(_call[1] as string[]);
				const { command } = getCommandArgs(args, _call[2] as ExecFileOptions | undefined);
				return command[0] === "worktree" && command[1] === "remove";
			});
			expect(removeCalls.length).toBeGreaterThanOrEqual(1);
		} finally {
			cleanup();
		}
	});

	it("resume with branch and no patch (test 24)", async () => {
		const { repoPath, cleanup } = setupSandbox();
		try {
			const worktreeHeads = new Map<string, string>();
			const existingBranches = new Set(["feat/no-patch"]);

			childProcessMocks.execFilePromise.mockImplementation(
				createBranchAwareMock({ worktreeHeads, existingBranches }),
			);

			const result = await ensureTaskWorktreeIfDoesntExist({
				cwd: repoPath,
				taskId: "task-no-patch",
				baseRef: "HEAD",
				branch: "feat/no-patch",
			});

			expect(result).toMatchObject({ ok: true });
			expect(result.ok && result.warning).toBeUndefined();
		} finally {
			cleanup();
		}
	});

	it("returns warning when branch worktree patch apply fails (existing branch path)", async () => {
		const { repoPath, runtimeHomePath, cleanup } = setupSandbox();
		try {
			const worktreeHeads = new Map<string, string>();
			const existingBranches = new Set(["feat/patch-fail"]);

			// Create a stored patch file so findTaskPatch returns it
			const patchesDir = join(runtimeHomePath, "trashed-task-patches");
			mkdirSync(patchesDir, { recursive: true });
			writeFileSync(join(patchesDir, "task-patch-fail.base-commit.patch"), "fake patch content", "utf8");

			childProcessMocks.execFilePromise.mockImplementation(
				async (_file: string, args: readonly string[], execOptions?: ExecFileOptions) => {
					const { command } = getCommandArgs(args, execOptions);

					// Handle git apply — simulate failure
					if (command[0] === "apply") {
						throw createGitError("error: patch failed");
					}

					// Delegate everything else to the standard branch-aware mock
					return createBranchAwareMock({ worktreeHeads, existingBranches })(_file, args, execOptions);
				},
			);

			const result = await ensureTaskWorktreeIfDoesntExist({
				cwd: repoPath,
				taskId: "task-patch-fail",
				baseRef: "HEAD",
				branch: "feat/patch-fail",
			});

			expect(result).toMatchObject({ ok: true });
			expect(result.ok && result.warning).toBe("Saved task changes could not be reapplied onto the branch.");
		} finally {
			cleanup();
		}
	});

	it("returns warning when branch worktree patch apply fails (new branch path)", async () => {
		const { repoPath, runtimeHomePath, cleanup } = setupSandbox();
		try {
			const worktreeHeads = new Map<string, string>();
			const existingBranches = new Set<string>(); // branch does NOT exist

			// Create a stored patch file so findTaskPatch returns it
			const patchesDir = join(runtimeHomePath, "trashed-task-patches");
			mkdirSync(patchesDir, { recursive: true });
			writeFileSync(join(patchesDir, "task-patch-fail-new.base-commit.patch"), "fake patch content", "utf8");

			childProcessMocks.execFilePromise.mockImplementation(
				async (_file: string, args: readonly string[], execOptions?: ExecFileOptions) => {
					const { command } = getCommandArgs(args, execOptions);

					// Handle git apply — simulate failure
					if (command[0] === "apply") {
						throw createGitError("error: patch failed");
					}

					// Delegate everything else to the standard branch-aware mock
					return createBranchAwareMock({ worktreeHeads, existingBranches })(_file, args, execOptions);
				},
			);

			const result = await ensureTaskWorktreeIfDoesntExist({
				cwd: repoPath,
				taskId: "task-patch-fail-new",
				baseRef: "HEAD",
				branch: "feat/patch-new",
			});

			expect(result).toMatchObject({ ok: true });
			expect(result.ok && result.warning).toBe(
				"Saved task changes could not be reapplied onto the recreated branch.",
			);
		} finally {
			cleanup();
		}
	});

	it("existing resume-from-trash without branch works unchanged (regression test 28)", async () => {
		const { repoPath, cleanup } = setupSandbox();
		try {
			const worktreeHeads = new Map<string, string>();
			const existingBranches = new Set<string>();

			childProcessMocks.execFilePromise.mockImplementation(
				createBranchAwareMock({ worktreeHeads, existingBranches }),
			);

			// No branch provided — should use detached HEAD
			const result = await ensureTaskWorktreeIfDoesntExist({
				cwd: repoPath,
				taskId: "task-no-branch",
				baseRef: "HEAD",
			});

			expect(result).toMatchObject({ ok: true, baseCommit: "base-commit" });
			// Verify detached HEAD was used
			const detachCalls = childProcessMocks.execFilePromise.mock.calls.filter((_call: unknown[]) => {
				const args = stripConfigFlags(_call[1] as string[]);
				const { command } = getCommandArgs(args, _call[2] as ExecFileOptions | undefined);
				return command[0] === "worktree" && command[1] === "add" && command[2] === "--detach";
			});
			expect(detachCalls.length).toBeGreaterThanOrEqual(1);
		} finally {
			cleanup();
		}
	});

	it("existing worktree creation without branch works unchanged (regression test 29)", async () => {
		const { repoPath, cleanup } = setupSandbox();
		try {
			const worktreeHeads = new Map<string, string>();
			const existingBranches = new Set<string>();

			childProcessMocks.execFilePromise.mockImplementation(
				createBranchAwareMock({ worktreeHeads, existingBranches }),
			);

			// branch: null — should also use detached HEAD
			const result = await ensureTaskWorktreeIfDoesntExist({
				cwd: repoPath,
				taskId: "task-null-branch",
				baseRef: "HEAD",
				branch: null,
			});

			expect(result).toMatchObject({ ok: true, baseCommit: "base-commit" });
			const detachCalls = childProcessMocks.execFilePromise.mock.calls.filter((_call: unknown[]) => {
				const args = stripConfigFlags(_call[1] as string[]);
				const { command } = getCommandArgs(args, _call[2] as ExecFileOptions | undefined);
				return command[0] === "worktree" && command[1] === "add" && command[2] === "--detach";
			});
			expect(detachCalls.length).toBeGreaterThanOrEqual(1);
		} finally {
			cleanup();
		}
	});
});
