import { existsSync } from "node:fs";
import { copyFile, mkdtemp, open, rename, rm, stat, utimes } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { createGitProcessEnv } from "../core";
import { removeDirectoryWithRetries } from "../fs/remove-path";
import { getGitStdout, runGit, splitNullSeparatedGitOutput } from "./git-utils";

async function copyIndex(source: string, target: string): Promise<void> {
	const metadata = await stat(source);
	await copyFile(source, target);
	// Git uses the index timestamp to detect racily clean entries. Never make a
	// copied index newer; round down because Node cannot preserve nanoseconds.
	await utimes(target, metadata.atime, Math.floor(metadata.mtimeMs / 1000));
}

/** Build a selected-file commit without changing the user's index until it succeeds. */
export async function commitSelectedPaths(repoRoot: string, paths: string[], message: string) {
	const options = { timeoutClass: "userAction" } as const;
	let tempDir: string | undefined;
	let indexLockPath: string | undefined;
	let commitHash: string | undefined;
	let output = "";
	try {
		if (paths.length === 0) throw new Error("Select at least one file to commit.");
		const gitDir = resolve(repoRoot, await getGitStdout(["rev-parse", "--git-dir"], repoRoot, options));
		const indexPath = join(gitDir, "index");
		// Use Git's index lock while preparing the commit and publishing selected entries.
		const lock = await open(`${indexPath}.lock`, "wx");
		indexLockPath = `${indexPath}.lock`;
		await lock.close();
		// A selected-file commit cannot conclude a merge or other conflicted operation.
		if (["MERGE_HEAD", "CHERRY_PICK_HEAD", "REVERT_HEAD"].some((name) => existsSync(join(gitDir, name)))) {
			throw new Error("Cannot commit selected files during a merge, cherry-pick, or revert.");
		}
		if (await getGitStdout(["ls-files", "--unmerged"], repoRoot, options)) {
			throw new Error("Resolve unmerged files before committing selected files.");
		}
		const deleted = new Set(
			splitNullSeparatedGitOutput(
				await getGitStdout(
					[
						"--literal-pathspecs",
						"diff",
						"--cached",
						"--no-renames",
						"--diff-filter=D",
						"--name-only",
						"-z",
						"--",
						...paths,
					],
					repoRoot,
					{ ...options, trimStdout: false },
				),
			),
		);
		tempDir = await mkdtemp(join(tmpdir(), "quarterdeck-commit-"));
		const tempOptions = { ...options, env: createGitProcessEnv({ GIT_INDEX_FILE: join(tempDir, "index") }) };
		const savedIndexPath = join(tempDir, "saved-index");
		const savedOptions = { ...options, env: createGitProcessEnv({ GIT_INDEX_FILE: savedIndexPath }) };
		if (existsSync(indexPath)) {
			await copyIndex(indexPath, savedIndexPath);
		} else {
			await getGitStdout(["read-tree", "--empty"], repoRoot, savedOptions);
		}
		const head = await runGit(repoRoot, ["rev-parse", "--verify", "HEAD"], options);
		await getGitStdout(head.ok ? ["read-tree", head.stdout] : ["read-tree", "--empty"], repoRoot, tempOptions);
		const toStage = paths.filter((path) => !deleted.has(path));
		if (toStage.length > 0) {
			await getGitStdout(["--literal-pathspecs", "add", "--", ...toStage], repoRoot, tempOptions);
		}
		if (deleted.size > 0) {
			// Keep staged removals even when ignored copies still exist in the worktree.
			await getGitStdout(["update-index", "--force-remove", "--", ...deleted], repoRoot, tempOptions);
		}
		output = await getGitStdout(["commit", "-m", message], repoRoot, tempOptions);
		commitHash = await getGitStdout(["rev-parse", "HEAD"], repoRoot, options);
		// Only synchronize selected entries. Unrelated staged/unstaged content stays intact.
		await getGitStdout(["--literal-pathspecs", "reset", "-q", commitHash, "--", ...paths], repoRoot, savedOptions);
		await copyIndex(savedIndexPath, indexLockPath);
		await rename(indexLockPath, indexPath);
		indexLockPath = undefined;
		return { ok: true, commitHash, output };
	} catch (error) {
		const reason = error instanceof Error ? error.message : "Failed to commit selected files.";
		return {
			ok: false,
			commitHash,
			output,
			error: commitHash ? `Commit ${commitHash} succeeded, but updating the staging area failed: ${reason}` : reason,
		};
	} finally {
		if (indexLockPath) await rm(indexLockPath, { force: true });
		if (tempDir) await removeDirectoryWithRetries(tempDir);
	}
}
