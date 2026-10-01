import { createHash } from "node:crypto";
import { readFile, realpath } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";

import { areFileSystemPathsEqual } from "../core";
import { isNodeError } from "../fs/node-error";

/** Stable across directory aliases and deletion of the checkout or its parent folders. */
export async function getTaskWorktreePathKey(worktreePath: string): Promise<string> {
	let existingPath = resolve(worktreePath);
	const missingSegments: string[] = [];
	while (true) {
		try {
			const absolutePath = join(await realpath(existingPath), ...missingSegments.reverse());
			const identity = process.platform === "win32" ? absolutePath.toLowerCase() : absolutePath;
			return createHash("sha256").update(identity).digest("hex");
		} catch (error) {
			const parent = dirname(existingPath);
			if (!isNodeError(error, "ENOENT") || parent === existingPath) throw error;
			missingSegments.push(basename(existingPath));
			existingPath = parent;
		}
	}
}

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
