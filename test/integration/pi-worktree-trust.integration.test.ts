import { mkdirSync, readFileSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { describe, expect, it, vi } from "vitest";

import { getRuntimeHomePath, getTaskWorktreesHomePath } from "../../src/state/project-state-utils";
import { prepareAgentLaunch } from "../../src/terminal/agent-session-adapters";
import { QUARTERDECK_PI_WORKTREE_TRUST_SCOPE_ENV } from "../../src/terminal/pi-lifecycle-extension";
import { resolvePiWorktreeTrustScope } from "../../src/terminal/pi-worktree-trust";
import { buildTerminalEnvironment } from "../../src/terminal/session-manager-types";
import { initGitRepository, runGit, stageAndCommitAll } from "../utilities/git-env";
import { withTemporaryHome } from "../utilities/temp-dir";

function createRepository(path: string): string {
	mkdirSync(path, { recursive: true });
	initGitRepository(path);
	writeFileSync(join(path, "tracked.txt"), "Synthetic task work\n");
	stageAndCommitAll(path, "Synthetic fixture");
	return path;
}

function createFixture(): { taskId: string; cwd: string; projectPath: string } {
	const projectPath = createRepository(join(getRuntimeHomePath(), "project"));
	const taskId = "task-pi";
	const cwd = join(getTaskWorktreesHomePath(), taskId, "project");
	runGit(projectPath, ["worktree", "add", "--detach", cwd]);
	return { taskId, cwd, projectPath };
}

describe("Pi managed worktree trust eligibility", { concurrent: false }, () => {
	it("gives fresh, explicit-resume, and exact-recovery launches the same verified canonical scope", async () => {
		await withTemporaryHome(async () => {
			const fixture = createFixture();
			const alias = join(getRuntimeHomePath(), "checkout-alias");
			symlinkSync(fixture.cwd, alias, process.platform === "win32" ? "junction" : "dir");
			for (const resume of [
				{},
				{ resumeConversation: true },
				{ resumeConversation: true, resumeSessionId: "exact-session" },
			]) {
				const launch = await prepareAgentLaunch({
					...fixture,
					...resume,
					cwd: alias,
					agentId: "pi",
					binary: "pi",
					args: ["--extension", "custom-extension.js"],
					prompt: "",
					projectId: "project-pi",
					hookSessionInstanceId: "launch-pi",
				});
				expect(launch.env[QUARTERDECK_PI_WORKTREE_TRUST_SCOPE_ENV]).toBe(realpathSync.native(fixture.cwd));
				expect(launch.args.slice(0, 2)).toEqual(["--extension", "custom-extension.js"]);
			}
		});
	});

	it("clears inherited and request-supplied trust scopes for ineligible or incomplete launches", async () => {
		await withTemporaryHome(async () => {
			const fixture = createFixture();
			vi.stubEnv(QUARTERDECK_PI_WORKTREE_TRUST_SCOPE_ENV, fixture.cwd);
			try {
				for (const missing of [
					{ projectId: undefined },
					{ hookSessionInstanceId: undefined },
					{ projectPath: undefined },
					{ taskId: "" },
					{ cwd: fixture.projectPath },
				]) {
					const input = {
						...fixture,
						projectId: "project-pi",
						hookSessionInstanceId: "launch-pi",
						...missing,
					};
					const requestEnv = { [QUARTERDECK_PI_WORKTREE_TRUST_SCOPE_ENV]: fixture.cwd };
					const launch = await prepareAgentLaunch({
						...input,
						agentId: "pi",
						args: [],
						prompt: "",
						env: requestEnv,
					});
					const env = buildTerminalEnvironment(requestEnv, launch.env);
					expect(env[QUARTERDECK_PI_WORKTREE_TRUST_SCOPE_ENV]).toBeUndefined();
				}
			} finally {
				vi.unstubAllEnvs();
			}
		});
	});

	it("rejects shared roots, another task, unregistered folders, and similarly prefixed siblings", async () => {
		await withTemporaryHome(async () => {
			const fixture = createFixture();
			const outside = `${getTaskWorktreesHomePath()}-other/task-pi/project`;
			runGit(fixture.projectPath, ["worktree", "add", "--detach", outside]);
			const unregistered = join(getTaskWorktreesHomePath(), fixture.taskId, "unregistered");
			mkdirSync(unregistered);
			for (const cwd of [fixture.projectPath, outside, unregistered, dirname(fixture.cwd)]) {
				expect(await resolvePiWorktreeTrustScope({ ...fixture, cwd })).toBeUndefined();
			}
			expect(await resolvePiWorktreeTrustScope({ ...fixture, taskId: "other-task" })).toBeUndefined();
			expect(await resolvePiWorktreeTrustScope({ ...fixture, taskId: "." })).toBeUndefined();
			expect(await resolvePiWorktreeTrustScope({ ...fixture, cwd: join(fixture.cwd, "absent") })).toBeUndefined();
			// Even a shared repository physically under managed storage is not a task worktree.
			const sharedRoot = createRepository(join(getTaskWorktreesHomePath(), fixture.taskId, "shared"));
			expect(
				await resolvePiWorktreeTrustScope({ ...fixture, cwd: sharedRoot, projectPath: sharedRoot }),
			).toBeUndefined();
		});
	});

	it("rejects symlink escapes and linked worktrees from a different repository", async () => {
		await withTemporaryHome(async () => {
			const fixture = createFixture();
			const outside = join(getRuntimeHomePath(), "outside");
			runGit(fixture.projectPath, ["worktree", "add", "--detach", outside]);
			const alias = join(dirname(fixture.cwd), "escape");
			symlinkSync(outside, alias, process.platform === "win32" ? "junction" : "dir");
			expect(await resolvePiWorktreeTrustScope({ ...fixture, cwd: alias })).toBeUndefined();
			const foreignProject = createRepository(join(getRuntimeHomePath(), "foreign"));
			const foreignCwd = join(dirname(fixture.cwd), "foreign");
			runGit(foreignProject, ["worktree", "add", "--detach", foreignCwd]);
			expect(await resolvePiWorktreeTrustScope({ ...fixture, cwd: foreignCwd })).toBeUndefined();
			// A symlink for the task root cannot widen managed ownership either.
			const aliasedTask = "alias-task";
			symlinkSync(
				getRuntimeHomePath(),
				join(getTaskWorktreesHomePath(), aliasedTask),
				process.platform === "win32" ? "junction" : "dir",
			);
			expect(
				await resolvePiWorktreeTrustScope({
					...fixture,
					taskId: aliasedTask,
					cwd: join(getTaskWorktreesHomePath(), aliasedTask, "outside"),
				}),
			).toBeUndefined();
		});
	});

	it("rejects stale registration pointing at another checkout and preserves task files", async () => {
		await withTemporaryHome(async () => {
			const fixture = createFixture();
			const otherCwd = join(dirname(fixture.cwd), "other");
			runGit(fixture.projectPath, ["worktree", "add", "--detach", otherCwd]);
			const staleGitFile = readFileSync(join(otherCwd, ".git"), "utf8");
			// Git marks this file hidden on Windows; replace it instead of truncating it.
			rmSync(join(fixture.cwd, ".git"));
			writeFileSync(join(fixture.cwd, ".git"), staleGitFile);
			expect(await resolvePiWorktreeTrustScope(fixture)).toBeUndefined();
			expect(readFileSync(join(fixture.cwd, ".git"), "utf8")).toBe(staleGitFile);
			expect(readFileSync(join(fixture.cwd, "tracked.txt"), "utf8")).toBe("Synthetic task work\n");
			rmSync(join(fixture.cwd, ".git"));
			expect(await resolvePiWorktreeTrustScope(fixture)).toBeUndefined();
		});
	});

	it("requires Git's live worktree listing even when a moved admin directory still has a valid backlink", async () => {
		await withTemporaryHome(async () => {
			const fixture = createFixture();
			const gitFile = readFileSync(join(fixture.cwd, ".git"), "utf8").trim();
			const adminPath = gitFile.slice("gitdir: ".length);
			// Keep the administrative files and common-dir pointer valid outside
			// .git/worktrees, where Git no longer lists this checkout as registered.
			const movedAdminPath = join(dirname(dirname(adminPath)), "unregistered", "project");
			mkdirSync(dirname(movedAdminPath));
			renameSync(adminPath, movedAdminPath);
			// Git marks this file hidden on Windows; replace it instead of truncating it.
			rmSync(join(fixture.cwd, ".git"));
			writeFileSync(join(fixture.cwd, ".git"), `gitdir: ${movedAdminPath}\n`);
			expect(runGit(fixture.cwd, ["rev-parse", "HEAD"])).toBe(runGit(fixture.projectPath, ["rev-parse", "HEAD"]));
			expect(await resolvePiWorktreeTrustScope(fixture)).toBeUndefined();
		});
	});
});
