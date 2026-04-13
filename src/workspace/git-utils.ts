import { execFile, spawnSync } from "node:child_process";
import { isAbsolute, join } from "node:path";
import { promisify } from "node:util";
import { createGitProcessEnv } from "../core/git-process-env";

const execFileAsync = promisify(execFile);
const GIT_MAX_BUFFER_BYTES = 10 * 1024 * 1024;

interface GitCommandResult {
	ok: boolean;
	stdout: string;
	stderr: string;
	output: string;
	error: string | null;
	exitCode: number;
}

export interface RunGitOptions {
	trimStdout?: boolean;
	env?: NodeJS.ProcessEnv;
}

function normalizeProcessExitCode(code: unknown): number {
	if (typeof code === "number" && Number.isFinite(code)) {
		return code;
	}
	if (typeof code === "string") {
		const parsed = Number(code);
		if (Number.isInteger(parsed)) {
			return parsed;
		}
	}
	return -1;
}

export async function runGit(cwd: string, args: string[], options: RunGitOptions = {}): Promise<GitCommandResult> {
	try {
		const fullArgs = ["-c", "core.quotepath=false", ...args];
		const { stdout, stderr } = await execFileAsync("git", fullArgs, {
			cwd,
			encoding: "utf8",
			maxBuffer: GIT_MAX_BUFFER_BYTES,
			env: options.env || createGitProcessEnv(),
		});
		const normalizedStdout = String(stdout ?? "").trim();
		const normalizedStderr = String(stderr ?? "").trim();
		return {
			ok: true,
			stdout: options.trimStdout === false ? stdout : normalizedStdout,
			stderr: normalizedStderr,
			output: [normalizedStdout, normalizedStderr].filter(Boolean).join("\n"),
			error: null,
			exitCode: 0,
		};
	} catch (error) {
		const candidate = error as {
			code?: string | number | null;
			stdout?: unknown;
			stderr?: unknown;
			message?: unknown;
		};
		const rawStdout = String(candidate.stdout ?? "");
		const stdout = options.trimStdout === false ? rawStdout : rawStdout.trim();
		const stderr = String(candidate.stderr ?? "").trim();
		const message = String(candidate.message ?? "").trim();
		const errorMessage = stderr || message || "Unknown git error";
		const exitCode = normalizeProcessExitCode(candidate.code);

		return {
			ok: false,
			stdout,
			stderr,
			output: [stdout, stderr].filter(Boolean).join("\n"),
			error: errorMessage,
			exitCode,
		};
	}
}

export async function getGitStdout(args: string[], cwd: string, options: RunGitOptions = {}): Promise<string> {
	const result = await runGit(cwd, args, options);
	if (!result.ok) {
		throw new Error(result.error || result.stdout);
	}

	return result.stdout;
}

export interface GitHeadInfo {
	branch: string | null;
	headCommit: string | null;
	isDetached: boolean;
}

/**
 * Read the current HEAD commit, branch name, and detached state for a
 * repository (or worktree) at `cwd`.
 */
export async function readGitHeadInfo(cwd: string): Promise<GitHeadInfo> {
	const headResult = await runGit(cwd, ["rev-parse", "--verify", "HEAD"]);
	const headCommit = headResult.ok ? headResult.stdout : null;
	const branchResult = await runGit(cwd, ["symbolic-ref", "--quiet", "--short", "HEAD"]);
	const branch = branchResult.ok ? branchResult.stdout : null;
	return {
		branch,
		headCommit,
		isDetached: headCommit !== null && branch === null,
	};
}

/**
 * Checks how many commits the base ref has advanced since the worktree branched from it.
 * Checks both `origin/{baseRef}` and local `{baseRef}` in parallel and returns whichever
 * shows more commits ahead, since either ref may be stale depending on fetch/pull timing.
 * Returns null if neither ref can be resolved (e.g. ref doesn't exist).
 */
export async function getCommitsBehindBase(
	cwd: string,
	baseRef: string,
): Promise<{ behindCount: number; mergeBase: string } | null> {
	if (!validateGitRef(baseRef)) return null;
	const originRef = `origin/${baseRef}`;

	// Check both origin and local refs, return whichever is further ahead.
	// Origin may be stale (no fetch), local may be stale (no pull) — take the max.
	const [originMergeBase, localMergeBase] = await Promise.all([
		runGit(cwd, ["--no-optional-locks", "merge-base", "HEAD", originRef]),
		runGit(cwd, ["--no-optional-locks", "merge-base", "HEAD", baseRef]),
	]);

	const [originCount, localCount] = await Promise.all([
		originMergeBase.ok
			? runGit(cwd, ["--no-optional-locks", "rev-list", "--count", `${originMergeBase.stdout}..${originRef}`])
			: null,
		localMergeBase.ok
			? runGit(cwd, ["--no-optional-locks", "rev-list", "--count", `${localMergeBase.stdout}..${baseRef}`])
			: null,
	]);
	const originBehind = originCount?.ok ? parseInt(originCount.stdout, 10) || 0 : 0;
	const originMB = originMergeBase.ok ? originMergeBase.stdout : null;
	const localBehind = localCount?.ok ? parseInt(localCount.stdout, 10) || 0 : 0;
	const localMB = localMergeBase.ok ? localMergeBase.stdout : null;

	if (originBehind >= localBehind && originMB) {
		return { behindCount: originBehind, mergeBase: originMB };
	}
	if (localMB) {
		return { behindCount: localBehind, mergeBase: localMB };
	}
	return null;
}

/**
 * Validate a git ref string for safe use in git commands.
 * Rejects refs that start with `-` (flag injection) or contain `..` (traversal).
 */
export function validateGitRef(ref: string): boolean {
	return ref.length > 0 && !ref.startsWith("-") && !ref.includes("..");
}

/**
 * Throwing variant of {@link validateGitRef} for use at API boundaries.
 */
export function assertValidGitRef(ref: string, label: string): void {
	if (!validateGitRef(ref)) {
		throw new Error(`Invalid ${label}: must not start with "-" or contain ".."`);
	}
}

/**
 * Validate a file path for safe use in git show commands.
 * Rejects paths containing `..` traversal.
 */
export function validateGitPath(path: string): boolean {
	return path.length > 0 && !path.includes("..");
}

/**
 * List all files at a specific git ref without touching the working tree.
 * Uses `git ls-tree -r --name-only`.
 */
export async function listFilesAtRef(cwd: string, ref: string): Promise<string[]> {
	if (!validateGitRef(ref)) {
		return [];
	}
	const result = await runGit(cwd, ["ls-tree", "-r", "--name-only", ref, "--"]);
	if (!result.ok) {
		return [];
	}
	return result.stdout.split("\n").filter(Boolean);
}

/**
 * Read file content at a specific git ref without touching the working tree.
 * Uses `git show ref:path`. Returns binary flag based on NUL byte detection.
 */
export async function getFileContentAtRef(
	cwd: string,
	ref: string,
	path: string,
): Promise<{ content: string; binary: boolean } | null> {
	if (!validateGitRef(ref) || !validateGitPath(path)) {
		return null;
	}
	const result = await runGit(cwd, ["show", `${ref}:${path}`], { trimStdout: false });
	if (!result.ok) {
		return null;
	}
	// Binary detection: check for NUL bytes in the first 8KB
	const sampleSize = Math.min(result.stdout.length, 8192);
	for (let i = 0; i < sampleSize; i++) {
		if (result.stdout.charCodeAt(i) === 0) {
			return { content: "", binary: true };
		}
	}
	return { content: result.stdout, binary: false };
}

/**
 * Resolve the git common directory for a repository or worktree.
 * For normal repos this is `.git/`; for worktrees it's the shared parent `.git` directory.
 */
export async function getGitCommonDir(repoPath: string): Promise<string> {
	const gitCommonDir = await getGitStdout(["rev-parse", "--git-common-dir"], repoPath);
	return isAbsolute(gitCommonDir) ? gitCommonDir : join(repoPath, gitCommonDir);
}

/**
 * Resolve the per-worktree git directory.
 * For the main working tree this is `.git/`; for worktrees it's `.git/worktrees/<name>/`.
 * This is the directory that contains the worktree's own `index`, `HEAD`, etc.
 */
export async function getGitDir(cwd: string): Promise<string> {
	const gitDir = await getGitStdout(["rev-parse", "--git-dir"], cwd);
	return isAbsolute(gitDir) ? gitDir : join(cwd, gitDir);
}

/**
 * Resolve the repository root directory for a given working directory.
 */
export async function resolveRepoRoot(cwd: string): Promise<string> {
	const result = await runGit(cwd, ["--no-optional-locks", "rev-parse", "--show-toplevel"]);
	if (!result.ok || !result.stdout) {
		throw new Error("No git repository detected for this workspace.");
	}
	return result.stdout;
}

/**
 * Check whether a specific git ref exists in the repository.
 */
export async function hasGitRef(repoRoot: string, ref: string): Promise<boolean> {
	const result = await runGit(repoRoot, ["show-ref", "--verify", "--quiet", ref]);
	return result.ok;
}

export function getGitCommandErrorMessage(error: unknown): string {
	if (error && typeof error === "object" && "stderr" in error) {
		const stderr = (error as { stderr?: unknown }).stderr;
		if (typeof stderr === "string" && stderr.trim()) {
			return stderr.trim();
		}
	}
	return error instanceof Error ? error.message : String(error);
}

// ---------------------------------------------------------------------------
// Shared git helpers extracted from git-sync / get-workspace-changes / workspace-state
// ---------------------------------------------------------------------------

/** Count newline-separated lines in a string (returns 0 for empty/falsy input). */
export function countLines(text: string): number {
	if (!text) {
		return 0;
	}
	return text.split("\n").length;
}

/** Parse `git diff --numstat` output into aggregate additions/deletions. */
export function parseNumstatTotals(output: string): { additions: number; deletions: number } {
	let additions = 0;
	let deletions = 0;

	for (const rawLine of output.split("\n")) {
		const line = rawLine.trim();
		if (!line) {
			continue;
		}
		const [addedRaw, deletedRaw] = line.split("\t");
		const added = Number.parseInt(addedRaw ?? "", 10);
		const deleted = Number.parseInt(deletedRaw ?? "", 10);
		if (Number.isFinite(added)) {
			additions += added;
		}
		if (Number.isFinite(deleted)) {
			deletions += deleted;
		}
	}

	return { additions, deletions };
}

/**
 * Parse a single numstat line into per-file additions/deletions.
 * Returns `null` if the line is empty or unparseable.
 */
export function parseNumstatLine(line: string): { additions: number; deletions: number } | null {
	const trimmed = line.trim();
	if (!trimmed) {
		return null;
	}
	const [addedRaw, deletedRaw] = trimmed.split("\t");
	const additions = Number.parseInt(addedRaw ?? "", 10);
	const deletions = Number.parseInt(deletedRaw ?? "", 10);
	return {
		additions: Number.isFinite(additions) ? additions : 0,
		deletions: Number.isFinite(deletions) ? deletions : 0,
	};
}

/**
 * Synchronous git command execution — returns trimmed stdout or null on failure.
 * Use sparingly; prefer the async {@link runGit} for most operations.
 */
export function runGitSync(cwd: string, args: string[]): string | null {
	const result = spawnSync("git", args, {
		cwd,
		encoding: "utf8",
		stdio: ["ignore", "pipe", "ignore"],
		env: createGitProcessEnv(),
	});
	if (result.status !== 0 || typeof result.stdout !== "string") {
		return null;
	}
	const value = result.stdout.trim();
	return value.length > 0 ? value : null;
}
