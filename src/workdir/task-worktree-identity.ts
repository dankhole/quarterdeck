import { readFile, realpath } from "node:fs/promises";
import { join, resolve } from "node:path";

import { areFileSystemPathsEqual } from "../core";

export class TaskWorktreeRegistrationError extends Error {
	constructor(worktreePath: string) {
		super(
			`Git worktree registration is missing or belongs to another workspace at "${worktreePath}". Task files were preserved. Repair the worktree registration before retrying.`,
		);
		this.name = "TaskWorktreeRegistrationError";
	}
}

/** A stale gitfile can resolve successfully after Git reuses its admin directory for another task. */
export async function assertTaskWorktreeRegistration(worktreePath: string): Promise<void> {
	try {
		const gitFilePath = join(worktreePath, ".git");
		const gitFile = (await readFile(gitFilePath, "utf8")).trim();
		if (!gitFile.startsWith("gitdir: ")) throw new Error("Invalid gitfile");
		const gitDir = resolve(worktreePath, gitFile.slice("gitdir: ".length));
		const backlink = (await readFile(join(gitDir, "gitdir"), "utf8")).trim();
		const [expectedPath, registeredPath] = await Promise.all([
			realpath(gitFilePath),
			realpath(resolve(gitDir, backlink)),
		]);
		if (!areFileSystemPathsEqual(expectedPath, registeredPath)) throw new Error("Worktree backlink mismatch");
	} catch {
		throw new TaskWorktreeRegistrationError(worktreePath);
	}
}
