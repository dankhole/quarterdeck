import { realpath, stat } from "node:fs/promises";
import { areFileSystemPathsEqual } from "../core";
import { runGit } from "../workdir/git-utils";

export async function assertPathIsDirectory(path: string): Promise<void> {
	const info = await stat(path);
	if (!info.isDirectory()) {
		throw new Error(`Project path is not a directory: ${path}`);
	}
}

export async function pathIsDirectory(path: string): Promise<boolean> {
	try {
		const info = await stat(path);
		return info.isDirectory();
	} catch {
		return false;
	}
}

export async function hasGitRepository(path: string): Promise<boolean> {
	const result = await runGit(path, ["rev-parse", "--show-toplevel"], {
		timeoutClass: "sync",
	});
	if (!result.ok || !result.stdout.trim()) return false;
	try {
		const [projectPath, gitRoot] = await Promise.all([realpath(path), realpath(result.stdout.trim())]);
		return areFileSystemPathsEqual(projectPath, gitRoot);
	} catch {
		return false;
	}
}
