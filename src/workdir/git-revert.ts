import { stat } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import type { RuntimeGitRevertRequest, RuntimeGitRevertResponse } from "../core";
import { getConflictState } from "./git-conflict";
import { resolveRepoRoot, runGit } from "./git-utils";

/** Revert one ordinary commit in the scoped checkout, leaving conflicts recoverable. */
export async function revertCommit(
	options: Omit<RuntimeGitRevertRequest, "taskScope"> & { cwd: string },
): Promise<RuntimeGitRevertResponse> {
	const { commitHash, expectedHead, expectedBranch } = options;
	const fail = (error: string): RuntimeGitRevertResponse => ({ ok: false, commitHash, output: "", error });
	if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/i.test(commitHash)) return fail("Invalid commit hash.");
	const cwd = await resolveRepoRoot(options.cwd);
	const head = await runGit(cwd, ["rev-parse", "HEAD"]);
	const branch = await runGit(cwd, ["symbolic-ref", "--quiet", "--short", "HEAD"]);
	if (!branch.ok) return fail("Check out a branch before reverting a commit.");
	if (!head.ok || head.stdout !== expectedHead || branch.stdout !== expectedBranch) {
		return fail("The checked-out branch changed. Refresh history and try again.");
	}
	const gitDirResult = await runGit(cwd, ["rev-parse", "--git-dir"]);
	if (!gitDirResult.ok) return fail("Could not inspect the Git operation state.");
	const gitDir = isAbsolute(gitDirResult.stdout) ? gitDirResult.stdout : join(cwd, gitDirResult.stdout);
	for (const marker of [
		"MERGE_HEAD",
		"REVERT_HEAD",
		"CHERRY_PICK_HEAD",
		"rebase-merge",
		"rebase-apply",
		"sequencer",
	]) {
		try {
			await stat(join(gitDir, marker));
			return fail("Complete or abort the current Git operation before reverting a commit.");
		} catch (error) {
			if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
		}
	}
	const status = await runGit(cwd, ["status", "--porcelain", "--untracked-files=normal"]);
	if (!status.ok) return fail(status.error ?? "Could not inspect working tree changes.");
	if (status.stdout) return fail("Commit or stash your changes before reverting a commit.");
	const parents = await runGit(cwd, ["rev-list", "--parents", "-n", "1", commitHash]);
	if (!parents.ok || !parents.stdout) return fail("Commit not found.");
	if (parents.stdout.split(/\s+/).length > 2) {
		return fail(
			"Reverting merge commits requires a mainline choice and is not supported here. Select an individual commit.",
		);
	}
	const ancestor = await runGit(cwd, ["merge-base", "--is-ancestor", commitHash, "HEAD"]);
	if (!ancestor.ok) return fail("Select a commit from the checked-out branch's history.");
	// Singleton revision range keeps a sequencer for continue/abort even if a commit hook fails.
	const result = await runGit(cwd, ["revert", "--no-edit", `${commitHash}^!`], { timeoutClass: "userAction" });
	const conflictState = result.ok ? undefined : ((await getConflictState(cwd)) ?? undefined);
	return {
		ok: result.ok,
		commitHash,
		output: result.output,
		conflictState,
		error: result.ok ? undefined : (result.error ?? "Revert could not complete."),
	};
}
