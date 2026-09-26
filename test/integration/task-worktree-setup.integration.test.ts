import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it, vi } from "vitest";
import { updateRuntimeConfig } from "../../src/config/runtime-config";
import { lockedFileSystem } from "../../src/fs/locked-file-system";
import { loadProjectContext } from "../../src/state/project-state";
import {
	ensureTaskWorktreeIfDoesntExist,
	getTaskWorktreePath,
	purgeTaskWorkspaceForDelete,
} from "../../src/workdir/task-worktree-lifecycle";
import { finishTaskWorktreeSetup, runWorktreeSetupScript } from "../../src/workdir/task-worktree-setup";
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
	it("copies before setup, installs locally, and runs once across starts and configuration changes", async () => {
		await fixture(async (repoPath, projectId) => {
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
