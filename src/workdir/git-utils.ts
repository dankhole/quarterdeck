import { type ExecFileException, execFile } from "node:child_process";
import { isAbsolute, join } from "node:path";
import {
	buildGitCommandArgs,
	createGitProcessEnv,
	INTEGRATION_BASE_REF_CANDIDATES,
	resolveWindowsCompatibleCommand,
	terminateProcessForTimeout,
} from "../core";

const GIT_MAX_BUFFER_BYTES = 10 * 1024 * 1024;
export const GIT_COMMAND_TIMEOUTS_MS = {
	default: 5_000,
	inspection: 30_000,
	metadata: 5_000,
	remoteFetch: 30_000,
	checkpoint: 30_000,
	sync: 5_000,
	userAction: 120_000,
} as const;

export type GitCommandTimeoutClass = keyof typeof GIT_COMMAND_TIMEOUTS_MS;

interface GitCommandResult {
	ok: boolean;
	stdout: string;
	stderr: string;
	output: string;
	error: string | null;
	exitCode: number;
	timedOut: boolean;
}

export interface RunGitOptions {
	trimStdout?: boolean;
	env?: NodeJS.ProcessEnv;
	timeoutMs?: number;
	timeoutClass?: GitCommandTimeoutClass;
}

export const GIT_INSPECTION_OPTIONS = { timeoutClass: "inspection" } as const satisfies RunGitOptions;
export const GIT_CHECKPOINT_OPTIONS = { timeoutClass: "checkpoint" } as const satisfies RunGitOptions;

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

function resolveGitTimeoutMs(options: { timeoutMs?: number; timeoutClass?: GitCommandTimeoutClass }): number {
	if (typeof options.timeoutMs === "number" && Number.isFinite(options.timeoutMs) && options.timeoutMs > 0) {
		return Math.floor(options.timeoutMs);
	}
	return GIT_COMMAND_TIMEOUTS_MS[options.timeoutClass ?? "default"];
}

function isTimeoutError(error: {
	code?: string | number | null;
	killed?: unknown;
	signal?: unknown;
	message?: unknown;
}): boolean {
	if (error.code === "ETIMEDOUT") {
		return true;
	}
	if (error.killed === true && error.signal === "SIGTERM") {
		return true;
	}
	const message = typeof error.message === "string" ? error.message.toLowerCase() : "";
	return message.includes("timed out") || message.includes("timeout");
}

interface GitCommandOutput {
	stdout: string;
	stderr: string;
}

function executeGitCommand(
	cwd: string,
	args: string[],
	env: NodeJS.ProcessEnv,
	timeoutMs: number,
): Promise<GitCommandOutput> {
	return new Promise((resolveCommand, rejectCommand) => {
		let timedOut = false;
		let timeout: NodeJS.Timeout | null = null;
		const command = resolveWindowsCompatibleCommand("git", args, process.platform, env);
		const child = execFile(
			command.binary,
			command.args,
			{
				cwd,
				encoding: "utf8",
				maxBuffer: GIT_MAX_BUFFER_BYTES,
				env,
				windowsHide: true,
			},
			(error: ExecFileException | null, stdout, stderr) => {
				if (timeout) clearTimeout(timeout);
				const normalizedStdout = String(stdout ?? "");
				const normalizedStderr = String(stderr ?? "");
				if (timedOut) {
					const timeoutError = Object.assign(new Error(`Git command timed out after ${timeoutMs}ms`), {
						code: "ETIMEDOUT",
						killed: true,
						signal: "SIGTERM",
						stdout: normalizedStdout,
						stderr: normalizedStderr,
					});
					rejectCommand(timeoutError);
					return;
				}
				if (error) {
					Object.assign(error, {
						stdout: "stdout" in error ? error.stdout : normalizedStdout,
						stderr: "stderr" in error ? error.stderr : normalizedStderr,
					});
					rejectCommand(error);
					return;
				}
				resolveCommand({ stdout: normalizedStdout, stderr: normalizedStderr });
			},
		);

		timeout = setTimeout(() => {
			timedOut = true;
			terminateProcessForTimeout(child);
		}, timeoutMs);
		timeout.unref();
	});
}

export async function runGit(cwd: string, args: string[], options: RunGitOptions = {}): Promise<GitCommandResult> {
	try {
		const fullArgs = buildGitCommandArgs(args);
		const { stdout, stderr } = await executeGitCommand(
			cwd,
			fullArgs,
			options.env || createGitProcessEnv(),
			resolveGitTimeoutMs(options),
		);
		const normalizedStdout = String(stdout ?? "").trim();
		const normalizedStderr = String(stderr ?? "").trim();
		return {
			ok: true,
			stdout: options.trimStdout === false ? stdout : normalizedStdout,
			stderr: normalizedStderr,
			output: [normalizedStdout, normalizedStderr].filter(Boolean).join("\n"),
			error: null,
			exitCode: 0,
			timedOut: false,
		};
	} catch (error) {
		const candidate = error as {
			code?: string | number | null;
			stdout?: unknown;
			stderr?: unknown;
			message?: unknown;
			killed?: unknown;
			signal?: unknown;
		};
		const rawStdout = String(candidate.stdout ?? "");
		const stdout = options.trimStdout === false ? rawStdout : rawStdout.trim();
		const stderr = String(candidate.stderr ?? "").trim();
		const message = String(candidate.message ?? "").trim();
		const timedOut = isTimeoutError(candidate);
		const timeoutMessage = `Git command timed out after ${resolveGitTimeoutMs(options)}ms`;
		const errorMessage = timedOut ? stderr || timeoutMessage : stderr || message || "Unknown git error";
		const exitCode = normalizeProcessExitCode(candidate.code);

		return {
			ok: false,
			stdout,
			stderr,
			output: [stdout, stderr].filter(Boolean).join("\n"),
			error: errorMessage,
			exitCode,
			timedOut,
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

/** Parse Git's `-z` filename output without trimming valid filename whitespace. */
export function splitNullSeparatedGitOutput(output: string): string[] {
	return output.split("\0").filter((value) => value.length > 0);
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
		runGit(cwd, ["--no-optional-locks", "merge-base", "HEAD", originRef], { timeoutClass: "metadata" }),
		runGit(cwd, ["--no-optional-locks", "merge-base", "HEAD", baseRef], { timeoutClass: "metadata" }),
	]);

	const [originCount, localCount] = await Promise.all([
		originMergeBase.ok
			? runGit(cwd, ["--no-optional-locks", "rev-list", "--count", `${originMergeBase.stdout}..${originRef}`], {
					timeoutClass: "metadata",
				})
			: null,
		localMergeBase.ok
			? runGit(cwd, ["--no-optional-locks", "rev-list", "--count", `${localMergeBase.stdout}..${baseRef}`], {
					timeoutClass: "metadata",
				})
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
 * Rejects absolute paths and traversal components while allowing ordinary file
 * names that merely contain two consecutive dots (for example, `..notes`).
 */
export function validateGitPath(path: string, platform: NodeJS.Platform = process.platform): boolean {
	if (!path || path.includes("\0")) return false;
	const normalizedSeparators = platform === "win32" ? path.replaceAll("\\", "/") : path;
	if (normalizedSeparators.startsWith("/") || (platform === "win32" && /^[A-Za-z]:\//u.test(normalizedSeparators))) {
		return false;
	}
	const components = normalizedSeparators.split("/");
	return components.every((component) => component.length > 0 && component !== "." && component !== "..");
}

/**
 * List all files at a specific git ref without touching the working tree.
 * Uses `git ls-tree -r --name-only`.
 */
export async function listFilesAtRef(cwd: string, ref: string): Promise<string[]> {
	if (!validateGitRef(ref)) {
		return [];
	}
	const result = await runGit(cwd, ["ls-tree", "-r", "--name-only", "-z", ref, "--"], {
		trimStdout: false,
		...GIT_INSPECTION_OPTIONS,
	});
	if (!result.ok) {
		return [];
	}
	return splitNullSeparatedGitOutput(result.stdout);
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
	const result = await runGit(cwd, ["show", `${ref}:${path}`], {
		trimStdout: false,
		...GIT_INSPECTION_OPTIONS,
	});
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
		throw new Error("No git repository detected for this project.");
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
// Shared git helpers extracted from git-sync / get-workdir-changes / project-state
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
 * Extract the destination path from a `git diff --numstat` path field.
 *
 * Without `--find-renames` the path is plain (`src/foo.ts`).
 * With `--find-renames` renames appear as either:
 *   - `oldpath => newpath`                  (simple)
 *   - `prefix/{oldname => newname}/suffix`  (brace notation)
 *
 * Returns the **new** (destination) path in all cases.
 */
function extractNumstatDestPath(raw: string): string {
	const arrowIdx = raw.indexOf(" => ");
	if (arrowIdx === -1) {
		return raw;
	}
	const braceOpen = raw.lastIndexOf("{", arrowIdx);
	if (braceOpen !== -1) {
		const braceClose = raw.indexOf("}", arrowIdx);
		if (braceClose !== -1) {
			const prefix = raw.slice(0, braceOpen);
			const newPart = raw.slice(arrowIdx + 4, braceClose);
			const suffix = raw.slice(braceClose + 1);
			return `${prefix}${newPart}${suffix}`;
		}
	}
	return raw.slice(arrowIdx + 4);
}

/**
 * Parse multi-line `git diff --numstat` output into per-file stats.
 * Returns a Map keyed by the destination path (the new path for renames).
 * Binary files (`-\t-\tpath`) are recorded as `{ additions: 0, deletions: 0 }`.
 */
export function parseNumstatPerFile(output: string): Map<string, { additions: number; deletions: number }> {
	const result = new Map<string, { additions: number; deletions: number }>();
	const addEntry = (header: string, path: string): void => {
		const firstTab = header.indexOf("\t");
		const secondTab = header.indexOf("\t", firstTab + 1);
		if (firstTab === -1 || secondTab === -1 || !path) return;
		const addedRaw = header.slice(0, firstTab);
		const deletedRaw = header.slice(firstTab + 1, secondTab);
		const additions = Number.parseInt(addedRaw, 10);
		const deletions = Number.parseInt(deletedRaw, 10);
		result.set(path, {
			additions: Number.isFinite(additions) ? additions : 0,
			deletions: Number.isFinite(deletions) ? deletions : 0,
		});
	};

	if (output.includes("\0")) {
		const tokens = output.split("\0");
		for (let index = 0; index < tokens.length; index += 1) {
			const header = tokens[index];
			if (!header) continue;
			const secondTab = header.indexOf("\t", header.indexOf("\t") + 1);
			if (secondTab === -1) continue;
			const inlinePath = header.slice(secondTab + 1);
			if (inlinePath) {
				addEntry(header, inlinePath);
				continue;
			}
			// `--numstat -z` emits renames as a counts-only header followed by
			// the exact source and destination paths in separate NUL fields.
			const destinationPath = tokens[index + 2];
			if (destinationPath) addEntry(header, destinationPath);
			index += 2;
		}
		return result;
	}

	// Retain support for callers with legacy line-delimited numstat output.
	// Strip only CRLF framing; trimming the whole line corrupts valid leading
	// and trailing whitespace in repository paths.
	for (const rawLine of output.split("\n")) {
		const line = rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine;
		const firstTab = line.indexOf("\t");
		const secondTab = line.indexOf("\t", firstTab + 1);
		if (firstTab === -1 || secondTab === -1) continue;
		addEntry(line, extractNumstatDestPath(line.slice(secondTab + 1)));
	}
	return result;
}

/**
 * Detect which base branch the current HEAD was forked from.
 *
 * Strategy:
 * 1. Check if the branch has an upstream tracking ref — if it points at a
 *    known integration branch (e.g. origin/main → main), use that.
 * 2. Otherwise, test each candidate base ref and pick the one whose merge-base
 *    with HEAD is closest (fewest commits between merge-base and HEAD).
 *
 * Returns null if no candidate can be resolved.
 */
export async function resolveBaseRefForBranch(
	cwd: string,
	currentBranch: string,
	projectDefaultBaseRef: string,
): Promise<string | null> {
	// 1. Check upstream tracking ref
	const upstreamResult = await runGit(
		cwd,
		["--no-optional-locks", "rev-parse", "--abbrev-ref", `${currentBranch}@{upstream}`],
		{ timeoutClass: "metadata" },
	);
	if (upstreamResult.ok && upstreamResult.stdout) {
		const upstream = upstreamResult.stdout;
		// Strip "origin/" prefix to get the local branch name
		const localName = upstream.startsWith("origin/") ? upstream.slice("origin/".length) : upstream;
		if (localName && localName !== currentBranch) {
			return localName;
		}
	}

	// 2. Build candidate list: project default + well-known integration branches
	const candidates = new Set<string>();
	if (projectDefaultBaseRef) {
		candidates.add(projectDefaultBaseRef);
	}
	for (const name of INTEGRATION_BASE_REF_CANDIDATES) {
		candidates.add(name);
	}
	// Don't consider the current branch as its own base
	candidates.delete(currentBranch);

	if (candidates.size === 0) {
		return null;
	}

	// 3. For each candidate, find distance from merge-base to HEAD
	const distanceChecks = await Promise.all(
		[...candidates].map(async (candidate) => {
			const mbResult = await runGit(cwd, ["--no-optional-locks", "merge-base", "HEAD", candidate], {
				timeoutClass: "metadata",
			});
			if (!mbResult.ok) return null;
			const countResult = await runGit(
				cwd,
				["--no-optional-locks", "rev-list", "--count", `${mbResult.stdout}..HEAD`],
				{ timeoutClass: "metadata" },
			);
			if (!countResult.ok) return null;
			const distance = parseInt(countResult.stdout, 10);
			if (!Number.isFinite(distance)) return null;
			return { candidate, distance };
		}),
	);

	const valid = distanceChecks.filter((entry): entry is { candidate: string; distance: number } => entry !== null);
	if (valid.length === 0) {
		return null;
	}

	// Pick the candidate with the smallest distance (closest ancestor)
	valid.sort((a, b) => a.distance - b.distance);
	return valid[0]?.candidate ?? null;
}
