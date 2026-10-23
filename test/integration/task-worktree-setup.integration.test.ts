import {
	existsSync,
	lstatSync,
	mkdirSync,
	readFileSync,
	realpathSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";
import { updateRuntimeConfig } from "../../src/config/runtime-config";
import { lockedFileSystem } from "../../src/fs/locked-file-system";
import { loadProjectContext } from "../../src/state/project-state";
import {
	ensureTaskWorktreeIfDoesntExist,
	getTaskWorktreePath,
	purgeTaskWorkspaceForDelete,
} from "../../src/workdir/task-worktree-lifecycle";
import { finishTaskWorktreeSetup, runWorktreeSetupScript } from "../../src/workdir/task-worktree-setup";
import { withTaskWorktreeOperationLock } from "../../src/workdir/task-worktree-setup-lock";
import * as worktreeSymlinks from "../../src/workdir/task-worktree-symlinks";
import { runGit } from "../utilities/git-env";
import { createTempDir, withTemporaryHome } from "../utilities/temp-dir";

async function fixture(run: (repoPath: string, projectId: string) => Promise<void>): Promise<void> {
	await withTemporaryHome(async () => {
		const temp = createTempDir("quarterdeck-setup-");
		try {
			const repoPath = join(temp.path, "repo");
			mkdirSync(repoPath);
			runGit(repoPath, ["init", "-b", "main"]);
			runGit(repoPath, ["config", "user.name", "Setup Test"]);
			runGit(repoPath, ["config", "user.email", "setup@example.com"]);
			writeFileSync(join(repoPath, ".gitignore"), ".env\nnode_modules/\n");
			writeFileSync(join(repoPath, ".worktreeinclude"), ".env\nnode_modules/\n");
			writeFileSync(
				join(repoPath, "setup.cjs"),
				`const fs = require('node:fs');
if (fs.readFileSync('.env', 'utf8') !== 'synthetic') process.exit(2);
if (fs.existsSync('node_modules/parent-only')) process.exit(3);
fs.mkdirSync('node_modules', { recursive: true });
fs.writeFileSync('node_modules/task-only', 'installed');
fs.appendFileSync('setup-count', '1');
console.log('setup complete');
`,
			);
			runGit(repoPath, ["add", "."]);
			runGit(repoPath, ["commit", "-m", "fixture"]);
			writeFileSync(join(repoPath, ".env"), "synthetic");
			mkdirSync(join(repoPath, "node_modules"));
			writeFileSync(join(repoPath, "node_modules", "parent-only"), "preserve");
			const context = await loadProjectContext(repoPath);
			await run(repoPath, context.projectId);
		} finally {
			await temp.cleanupAsync();
		}
	});
}

describe("creation-time worktree setup", { concurrent: false }, () => {
	afterEach(() => vi.restoreAllMocks());

	it("copies before setup, installs locally, and runs once across starts and configuration changes", async () => {
		await fixture(async (repoPath, projectId) => {
			const cleanup = vi.spyOn(worktreeSymlinks, "cleanupLegacyDependencySymlinks");
			await updateRuntimeConfig(projectId, { worktreeSetupScript: "node setup.cjs" });
			const phases: string[] = [];
			const options = { cwd: repoPath, taskId: "setup-once", baseRef: "main" };
			const first = await ensureTaskWorktreeIfDoesntExist({
				...options,
				onSetupProgress: async (phase) => {
					phases.push(phase);
				},
			});
			expect(first.ok, first.error).toBe(true);
			if (!first.ok) return;
			expect(phases).toEqual(["running", "succeeded"]);
			expect(readFileSync(join(first.path, "setup-count"), "utf8")).toBe("1");
			expect(readFileSync(join(first.path, "node_modules/task-only"), "utf8")).toBe("installed");
			expect(existsSync(join(repoPath, "node_modules/task-only"))).toBe(false);
			await updateRuntimeConfig(projectId, { worktreeSetupScript: "exit 9" });
			expect((await ensureTaskWorktreeIfDoesntExist({ ...options, retrySetup: true })).ok).toBe(true);
			expect(readFileSync(join(first.path, "setup-count"), "utf8")).toBe("1");
			expect(cleanup).toHaveBeenCalledExactlyOnceWith(first.path);
		});
	});

	it.each([null, "succeeded"])(
		"cleans old worktrees once without running scripts (setup state: %s)",
		async (status) => {
			await fixture(async (repoPath) => {
				const worktreePath = join(repoPath, "old-worktree");
				runGit(repoPath, ["worktree", "add", "--detach", worktreePath, "HEAD"]);
				const directory = resolve(worktreePath, runGit(worktreePath, ["rev-parse", "--git-dir"]).trim());
				if (status)
					writeFileSync(join(directory, "quarterdeck-setup.json"), JSON.stringify({ version: 1, status }));
				const linkType = process.platform === "win32" ? "junction" : "dir";
				const target = join(repoPath, "node_modules");
				for (const parent of [".venv/nested", "target/deep/nested"]) {
					mkdirSync(join(worktreePath, parent), { recursive: true });
					symlinkSync(target, join(worktreePath, parent, "node_modules"), linkType);
				}
				mkdirSync(join(worktreePath, "node_modules"));
				writeFileSync(join(worktreePath, "node_modules/task-only"), "local install");
				mkdirSync(join(repoPath, "legacy"));
				symlinkSync(target, join(repoPath, "legacy/node_modules"), linkType);
				symlinkSync(join(repoPath, "legacy"), join(worktreePath, "legacy"), linkType);
				const cleanup = vi.spyOn(worktreeSymlinks, "cleanupLegacyDependencySymlinks");
				const options = { repoPath, worktreePath, script: "node setup.cjs", retrySetup: true };
				// The existing operation lock serializes concurrent starts/recovery around the marker.
				await Promise.all([finishTaskWorktreeSetup(options), finishTaskWorktreeSetup(options)]);
				mkdirSync(join(worktreePath, "reintroduced"));
				symlinkSync(target, join(worktreePath, "reintroduced/node_modules"), linkType);
				await finishTaskWorktreeSetup(options);
				expect(lstatSync(join(worktreePath, "reintroduced/node_modules")).isSymbolicLink()).toBe(true);
				expect(cleanup).toHaveBeenCalledExactlyOnceWith(worktreePath);
				expect(readFileSync(join(directory, "quarterdeck-legacy-dependency-cleanup-v1.done"), "utf8")).toBe("1\n");
				expect(existsSync(join(worktreePath, "setup-count"))).toBe(false);
				for (const parent of [".venv/nested", "target/deep/nested"]) {
					expect(existsSync(join(worktreePath, parent, "node_modules"))).toBe(false);
				}
				expect(readFileSync(join(worktreePath, "node_modules/task-only"), "utf8")).toBe("local install");
				expect(lstatSync(join(repoPath, "legacy/node_modules")).isSymbolicLink()).toBe(true);
				expect(readFileSync(join(target, "parent-only"), "utf8")).toBe("preserve");
				if (!status) expect(existsSync(join(directory, "quarterdeck-setup.json"))).toBe(false);
			});
		},
	);

	it.each(["cleanup", "marker write"])("retries after failed %s without recording completion", async (failure) => {
		await fixture(async (repoPath) => {
			const worktreePath = join(repoPath, "old-worktree");
			runGit(repoPath, ["worktree", "add", "--detach", worktreePath, "HEAD"]);
			const directory = resolve(worktreePath, runGit(worktreePath, ["rev-parse", "--git-dir"]).trim());
			const marker = join(directory, "quarterdeck-legacy-dependency-cleanup-v1.done");
			const cleanup = vi.spyOn(worktreeSymlinks, "cleanupLegacyDependencySymlinks");
			if (failure === "cleanup") cleanup.mockRejectedValueOnce(new Error("synthetic cleanup failure"));
			else
				vi.spyOn(lockedFileSystem, "writeTextFileAtomic").mockRejectedValueOnce(
					new Error("synthetic marker write failure"),
				);
			const options = { repoPath, worktreePath, script: "node setup.cjs" };
			if (failure === "cleanup") {
				await expect(finishTaskWorktreeSetup(options)).rejects.toThrow("synthetic cleanup failure");
			} else {
				await expect(finishTaskWorktreeSetup(options)).resolves.toBeUndefined();
			}
			expect(existsSync(marker)).toBe(false);
			await finishTaskWorktreeSetup(options);
			await finishTaskWorktreeSetup(options);
			expect(cleanup).toHaveBeenCalledTimes(2);
			expect(existsSync(marker)).toBe(true);
			expect(existsSync(join(directory, "quarterdeck-setup.json"))).toBe(false);
			expect(existsSync(join(worktreePath, "setup-count"))).toBe(false);
		});
	});

	it("preserves failed setup files, blocks implicit reuse, and explicitly retries using corrected configuration", async () => {
		await fixture(async (repoPath, projectId) => {
			await updateRuntimeConfig(projectId, { worktreeSetupScript: "node setup.cjs\nexit 7" });
			const options = { cwd: repoPath, taskId: "setup-retry", baseRef: "main" };
			const first = await ensureTaskWorktreeIfDoesntExist(options);
			expect(first.ok).toBe(false);
			expect(first.error).toContain("exit 7");
			expect(first.error).toContain("files were preserved");
			const blocked = await ensureTaskWorktreeIfDoesntExist(options);
			expect(blocked.ok).toBe(false);
			expect(blocked.error).toContain("explicitly to retry");
			await updateRuntimeConfig(projectId, { worktreeSetupScript: "node setup.cjs" });
			const retry = await ensureTaskWorktreeIfDoesntExist({ ...options, retrySetup: true });
			expect(retry.ok, retry.error).toBe(true);
			if (!retry.ok) return;
			expect(readFileSync(join(retry.path, "setup-count"), "utf8")).toBe("11");
			await finishTaskWorktreeSetup({ repoPath, worktreePath: retry.path, script: "exit 8" });
			expect(readFileSync(join(repoPath, "node_modules/parent-only"), "utf8")).toBe("preserve");
		});
	});

	it("waits for setup ownership before purging the worktree", async () => {
		await fixture(async (repoPath, projectId) => {
			await updateRuntimeConfig(projectId, { worktreeSetupScript: "node setup.cjs" });
			let markRunning = () => {};
			let releaseSetup = () => {};
			const running = new Promise<void>((resolve) => {
				markRunning = resolve;
			});
			const released = new Promise<void>((resolve) => {
				releaseSetup = resolve;
			});
			const taskId = "setup-purge-race";
			const worktreePath = getTaskWorktreePath(repoPath, taskId);
			const setup = ensureTaskWorktreeIfDoesntExist({
				cwd: repoPath,
				taskId,
				baseRef: "main",
				onSetupProgress: async (phase) => {
					if (phase === "running") {
						markRunning();
						await released;
					}
				},
			});
			await running;
			let purged = false;
			const lockAttempts = vi.spyOn(lockedFileSystem, "withLock");
			const purge = purgeTaskWorkspaceForDelete({ repoPath, taskId }).then((result) => {
				purged = true;
				return result;
			});
			try {
				// Observe the removal attempt at the same stable lock, before releasing setup.
				await vi.waitFor(() =>
					expect(lockAttempts.mock.calls.some(([request]) => request.path.includes("quarterdeck-worktree-"))).toBe(
						true,
					),
				);
				await new Promise((resolve) => setTimeout(resolve, 100));
				expect(purged).toBe(false);
				expect(existsSync(worktreePath)).toBe(true);
			} finally {
				lockAttempts.mockRestore();
				releaseSetup();
				const [setupResult, purgeResult] = await Promise.all([setup, purge]);
				expect(setupResult.ok, setupResult.error).toBe(true);
				expect(purgeResult.ok, purgeResult.error).toBe(true);
				expect(purgeResult.removed).toBe(true);
			}
			expect(existsSync(worktreePath)).toBe(false);
		});
	});

	it.each([false, true])("shares operation ownership across folder aliases after removal: %s", async (removed) => {
		await fixture(async (repoPath) => {
			const checkoutRoot = join(repoPath, "checkouts");
			const alias = join(repoPath, "checkout-alias");
			const checkout = join(checkoutRoot, "task", "worktree");
			mkdirSync(checkout, { recursive: true });
			symlinkSync(checkoutRoot, alias, process.platform === "win32" ? "junction" : "dir");
			const canonicalCheckout = realpathSync(checkout);
			let entered = () => {};
			let release = () => {};
			const ownerEntered = new Promise<void>((resolve) => {
				entered = resolve;
			});
			const ownerReleased = new Promise<void>((resolve) => {
				release = resolve;
			});
			const locks = vi.spyOn(lockedFileSystem, "withLock");
			const owner = withTaskWorktreeOperationLock(repoPath, join(alias, "task", "worktree"), async () => {
				if (removed) rmSync(join(checkoutRoot, "task"), { recursive: true });
				entered();
				await ownerReleased;
			});
			await ownerEntered;
			const enterContender = vi.fn(async () => undefined);
			const contender = withTaskWorktreeOperationLock(repoPath, canonicalCheckout, enterContender);
			try {
				await vi.waitFor(() => expect(locks.mock.calls).toHaveLength(2));
				expect(locks.mock.calls[1]?.[0].path).toBe(locks.mock.calls[0]?.[0].path);
				expect(enterContender).not.toHaveBeenCalled();
			} finally {
				release();
				await Promise.all([owner, contender]);
				locks.mockRestore();
			}
			expect(enterContender).toHaveBeenCalledOnce();
		});
	});

	it.skipIf(process.platform === "win32")("reaps background descendants when the setup shell exits", async () => {
		const temp = createTempDir("quarterdeck-setup-descendant-");
		try {
			writeFileSync(
				join(temp.path, "background.cjs"),
				`const { spawn } = require('node:child_process');
spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], { stdio: 'inherit' }).unref();
console.log('parent finished');
`,
			);
			const logPath = join(temp.path, "setup.log");
			await runWorktreeSetupScript({
				worktreePath: temp.path,
				script: "node background.cjs",
				logPath,
				timeoutMs: 3000,
			});
			expect(readFileSync(logPath, "utf8")).toContain("parent finished");
		} finally {
			await temp.cleanupAsync();
		}
	});

	it("times out foreground scripts and retains only a bounded output log", async () => {
		const temp = createTempDir("quarterdeck-setup-process-");
		try {
			writeFileSync(
				join(temp.path, "wait.cjs"),
				"process.stdout.write('x'.repeat(100000)); setInterval(() => {}, 1000);",
			);
			const logPath = join(temp.path, "setup.log");
			await expect(
				runWorktreeSetupScript({ worktreePath: temp.path, script: "node wait.cjs", logPath, timeoutMs: 1000 }),
			).rejects.toThrow("timed out");
			expect(readFileSync(logPath).length).toBe(64 * 1024);
		} finally {
			await temp.cleanupAsync();
		}
	});
});
