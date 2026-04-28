import type {
	RuntimeStashDropResponse,
	RuntimeStashEntry,
	RuntimeStashListResponse,
	RuntimeStashPopApplyResponse,
	RuntimeStashPushResponse,
	RuntimeStashShowResponse,
} from "../core";
import { GIT_INSPECTION_OPTIONS, resolveRepoRoot, runGit, validateGitPath } from "./git-utils";

const USER_GIT_ACTION_OPTIONS = { timeoutClass: "userAction" } as const;

/**
 * Stash changes in the working tree.
 * Always includes untracked files via `--include-untracked`.
 * If `paths` is non-empty, only the specified files are stashed.
 */
export async function stashPush(options: {
	cwd: string;
	paths?: string[];
	message?: string;
}): Promise<RuntimeStashPushResponse> {
	const repoRoot = await resolveRepoRoot(options.cwd);
	const paths = options.paths ?? [];

	for (const p of paths) {
		if (!validateGitPath(p)) {
			return { ok: false, error: `Invalid file path: ${p}` };
		}
	}

	const args = ["stash", "push", "--include-untracked"];
	if (options.message) {
		args.push("-m", options.message);
	}
	if (paths.length > 0) {
		args.push("--", ...paths);
	}

	const result = await runGit(repoRoot, args, USER_GIT_ACTION_OPTIONS);
	if (!result.ok) {
		return { ok: false, error: result.error ?? "Stash push failed." };
	}

	// git stash push exits 0 even when there is nothing to stash.
	if (/no local changes to save/i.test(result.output)) {
		return { ok: false, error: "No local changes to save." };
	}

	return { ok: true };
}

/**
 * List all stash entries with metadata.
 * Uses a custom format to parse index, subject (branch + message), and date.
 */
export async function stashList(cwd: string): Promise<RuntimeStashListResponse> {
	const repoRoot = await resolveRepoRoot(cwd);

	const result = await runGit(repoRoot, ["stash", "list", "--format=%gd%x1f%gs%x1f%ci"], GIT_INSPECTION_OPTIONS);
	if (!result.ok) {
		return { ok: false, entries: [], error: result.error ?? "Stash list failed." };
	}

	if (!result.stdout) {
		return { ok: true, entries: [] };
	}

	const entries: RuntimeStashEntry[] = [];
	for (const line of result.stdout.split("\n")) {
		if (!line) continue;

		const parts = line.split("\x1f");
		if (parts.length < 3) continue;

		const refName = parts[0] as string;
		const subject = parts[1] as string;
		const dateStr = parts[2] as string;

		// Extract index from stash@{N}
		const indexMatch = refName.match(/^stash@\{(\d+)\}$/);
		if (!indexMatch) continue;
		const index = Number.parseInt(indexMatch[1] ?? "0", 10);

		// Extract branch and message from subject.
		// Format: "On <branch>: <message>" or "WIP on <branch>: <hash> <commit-msg>"
		let branch = "";
		let message: string = subject;
		const subjectMatch = subject.match(/^(?:On|WIP on) ([^:]+):\s*(.*)$/);
		if (subjectMatch) {
			branch = subjectMatch[1] ?? "";
			message = subjectMatch[2] ?? "";
		}

		entries.push({ index, message, branch, date: dateStr });
	}

	return { ok: true, entries };
}

/**
 * Pop a stash entry by index, restoring changes and removing the entry.
 * If conflicts occur, the entry is NOT removed (git's default behavior).
 */
export async function stashPop(options: { cwd: string; index: number }): Promise<RuntimeStashPopApplyResponse> {
	const repoRoot = await resolveRepoRoot(options.cwd);
	const result = await runGit(repoRoot, ["stash", "pop", `stash@{${options.index}}`], USER_GIT_ACTION_OPTIONS);

	if (!result.ok) {
		// Git writes CONFLICT messages to stdout, not stderr.
		const conflicted = /conflict/i.test(result.output);
		return {
			ok: false,
			conflicted,
			error: conflicted ? "Stash applied with conflicts." : (result.error ?? "Stash pop failed."),
		};
	}

	return { ok: true, conflicted: false };
}

/**
 * Apply a stash entry by index without removing it from the stack.
 * If conflicts occur, changes are partially applied.
 */
export async function stashApply(options: { cwd: string; index: number }): Promise<RuntimeStashPopApplyResponse> {
	const repoRoot = await resolveRepoRoot(options.cwd);
	const result = await runGit(repoRoot, ["stash", "apply", `stash@{${options.index}}`], USER_GIT_ACTION_OPTIONS);

	if (!result.ok) {
		// Git writes CONFLICT messages to stdout, not stderr.
		const conflicted = /conflict/i.test(result.output);
		return {
			ok: false,
			conflicted,
			error: conflicted ? "Stash applied with conflicts." : (result.error ?? "Stash apply failed."),
		};
	}

	return { ok: true, conflicted: false };
}

/**
 * Drop a stash entry by index without applying it.
 */
export async function stashDrop(options: { cwd: string; index: number }): Promise<RuntimeStashDropResponse> {
	const repoRoot = await resolveRepoRoot(options.cwd);
	const result = await runGit(repoRoot, ["stash", "drop", `stash@{${options.index}}`], USER_GIT_ACTION_OPTIONS);

	if (!result.ok) {
		return { ok: false, error: result.error ?? "Stash drop failed." };
	}

	return { ok: true };
}

/**
 * Show the diff of a stash entry.
 */
export async function stashShow(options: { cwd: string; index: number }): Promise<RuntimeStashShowResponse> {
	const repoRoot = await resolveRepoRoot(options.cwd);
	const result = await runGit(repoRoot, ["stash", "show", "-p", `stash@{${options.index}}`], GIT_INSPECTION_OPTIONS);

	if (!result.ok) {
		return { ok: false, error: result.error ?? "Stash show failed." };
	}

	return { ok: true, diff: result.stdout };
}

/**
 * Count the number of stash entries. Used in metadata polling.
 * Uses `--no-optional-locks` to avoid lock contention with concurrent agent operations.
 */
export async function stashCount(cwd: string): Promise<number> {
	const repoRoot = await resolveRepoRoot(cwd);
	const result = await runGit(repoRoot, ["--no-optional-locks", "stash", "list"]);
	if (!result.ok || !result.stdout) {
		return 0;
	}
	return result.stdout.split("\n").filter(Boolean).length;
}
