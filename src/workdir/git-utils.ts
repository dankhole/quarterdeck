import { type ExecFileException, execFile } from "node:child_process";
import { realpath } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import {
	armChildProcessTimeout,
	buildGitCommandArgs,
	type ChildProcessTimeoutGuard,
	createGitProcessEnv,
	INTEGRATION_BASE_REF_CANDIDATES,
	KeyedOperationCoordinator,
	normalizeFileSystemPathForComparison,
	resolveWindowsCompatibleCommand,
} from "../core";
import { assertRuntimeProcessLaunchAdmission } from "../core/runtime-process-launch-admission.js";
import {
	GitProcessAdmissionAbortedError,
	GitProcessLimiter,
	type GitProcessLimiterSnapshot,
	type GitProcessPriority,
	GitProcessQueueTimeoutError,
} from "./git-process-limiter";

const GIT_MAX_BUFFER_BYTES = 10 * 1024 * 1024;
/**
 * Global cap on concurrently running Git processes started through `runGit`.
 * Foreground work (availability, sync, and default-class request commands) is
 * admitted before explicit user actions and background metadata, inspection,
 * and remote fetches. Set to `Infinity` to disable the limiter.
 */
export const GIT_PROCESS_CONCURRENCY_LIMIT = 8;
/** Slots that `userAction` and background commands may never occupy. */
export const GIT_FOREGROUND_RESERVED_SLOTS = 2;
/** Maximum simultaneous explicit long-running user commands. */
export const GIT_USER_ACTION_CONCURRENCY_LIMIT = 3;
const gitProcessLimiter = new GitProcessLimiter(GIT_PROCESS_CONCURRENCY_LIMIT, GIT_FOREGROUND_RESERVED_SLOTS, {
	userActionLimit: GIT_USER_ACTION_CONCURRENCY_LIMIT,
});
/**
 * Longest a foreground command waits for a process slot. Exceeding it yields an
 * indeterminate `queue_timed_out` failure instead of an unbounded admission wait.
 */
export const GIT_FOREGROUND_QUEUE_MAX_WAIT_MS = 15_000;
const remoteGitCommands = new KeyedOperationCoordinator();
export const GIT_COMMAND_TIMEOUTS_MS = {
	default: 5_000,
	inspection: 30_000,
	metadata: 5_000,
	remoteFetch: 30_000,
	sync: 5_000,
	userAction: 120_000,
} as const;

export type GitCommandTimeoutClass = keyof typeof GIT_COMMAND_TIMEOUTS_MS;

/** Every timeout class maps to an explicit admission class; `default` is request-path work. */
const GIT_PROCESS_PRIORITY_BY_TIMEOUT_CLASS: Record<GitCommandTimeoutClass, GitProcessPriority> = {
	default: "foreground",
	sync: "foreground",
	userAction: "userAction",
	inspection: "background",
	metadata: "background",
	remoteFetch: "background",
};

export function resolveGitProcessPriority(options: {
	priority?: GitProcessPriority;
	timeoutClass?: GitCommandTimeoutClass;
}): GitProcessPriority {
	return options.priority ?? GIT_PROCESS_PRIORITY_BY_TIMEOUT_CLASS[options.timeoutClass ?? "default"];
}

export function getGitProcessLimiterSnapshot(): GitProcessLimiterSnapshot {
	return gitProcessLimiter.getSnapshot();
}

export type GitCommandFailureKind =
	| "launch_blocked"
	| "spawn_unavailable"
	| "permission_denied"
	| "timed_out"
	| "queue_timed_out"
	| "aborted"
	| "command_failed";
export type GitCommandErrorCode =
	| "ENOENT"
	| "EACCES"
	| "EPERM"
	| "ETIMEDOUT"
	| "ERR_CHILD_PROCESS_STDIO_MAXBUFFER"
	| "EAGAIN"
	| "EMFILE"
	| "ENFILE"
	| "ENOMEM";

interface GitCommandResult {
	ok: boolean;
	stdout: string;
	stderr: string;
	output: string;
	error: string | null;
	exitCode: number;
	timedOut: boolean;
	/** True when the process ended by a signal that was not our own timeout termination (e.g. an external OOM kill). */
	terminatedBySignal?: boolean;
	failureKind?: GitCommandFailureKind;
	errorCode?: GitCommandErrorCode | null;
}

class GitLaunchAdmissionError extends Error {
	constructor(cause: unknown) {
		super(cause instanceof Error ? cause.message : "Git process launch admission failed.", { cause });
	}
}

function boundedGitErrorCode(code: unknown): GitCommandErrorCode | null {
	switch (code) {
		case "ENOENT":
		case "EACCES":
		case "EPERM":
		case "ETIMEDOUT":
		case "ERR_CHILD_PROCESS_STDIO_MAXBUFFER":
		case "EAGAIN":
		case "EMFILE":
		case "ENFILE":
		case "ENOMEM":
			return code;
		default:
			return null;
	}
}

export interface RunGitOptions {
	trimStdout?: boolean;
	/** Written to the process's stdin, which is then closed; for Git's transactional plumbing, never a shell. */
	stdin?: string;
	env?: NodeJS.ProcessEnv;
	timeoutMs?: number;
	timeoutClass?: GitCommandTimeoutClass;
	/** Overrides the admission priority derived from `timeoutClass`. */
	priority?: GitProcessPriority;
	/** Cancels the command while it is still waiting for a process slot. */
	signal?: AbortSignal;
}

export const GIT_INSPECTION_OPTIONS = { timeoutClass: "inspection" } as const satisfies RunGitOptions;

/** The Git command a user explicitly requested: commit, stash, merge, revert, cherry-pick, sync, etc. */
export const GIT_USER_ACTION_OPTIONS = { timeoutClass: "userAction" } as const satisfies RunGitOptions;

/**
 * For a preflight (repo-root resolution, status/diff probe) nested inside a
 * user action, not the action command itself. `inspection`'s `background`
 * admission priority has no queue-wait bound, so under heavy load a
 * foreground user action's own preflight could queue behind unlimited
 * background work; `userAction`'s full 120s timeout is also far longer than
 * a preflight should ever need. This runs at `foreground` priority (bounded
 * by `GIT_FOREGROUND_QUEUE_MAX_WAIT_MS`) with a moderate 30s timeout, so a
 * hung preflight surfaces "Git did not respond in time; retry." in ~30s
 * instead of up to 120s, while still queuing ahead of background work.
 */
export const GIT_USER_ACTION_PREFLIGHT_OPTIONS = {
	timeoutMs: 30_000,
	priority: "foreground",
} as const satisfies RunGitOptions;

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
	// Buffer exhaustion and launch errors can also terminate a process. Their
	// explicit codes take precedence over generic killed/signal heuristics.
	if (boundedGitErrorCode(error.code) !== null) {
		return false;
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

/** Waits for a process slot first; the command timeout starts only once the process is spawned. */
function executeGitCommand(
	cwd: string,
	args: string[],
	env: NodeJS.ProcessEnv,
	timeoutMs: number,
	priority: GitProcessPriority,
	options: { signal?: AbortSignal; stdin?: string } = {},
): Promise<GitCommandOutput> {
	return gitProcessLimiter.run(priority, () => spawnGitCommand(cwd, args, env, timeoutMs, options.stdin), {
		signal: options.signal,
		maxWaitMs: priority === "foreground" ? GIT_FOREGROUND_QUEUE_MAX_WAIT_MS : undefined,
	});
}

function spawnGitCommand(
	cwd: string,
	args: string[],
	env: NodeJS.ProcessEnv,
	timeoutMs: number,
	stdin?: string,
): Promise<GitCommandOutput> {
	return new Promise((resolveCommand, rejectCommand) => {
		const command = resolveWindowsCompatibleCommand("git", args, process.platform, env);
		try {
			assertRuntimeProcessLaunchAdmission();
		} catch (error) {
			throw new GitLaunchAdmissionError(error);
		}
		// `guard` is assigned after `execFile` returns; a mocked callback that fires
		// synchronously sees it as null and `settled` prevents arming it at all.
		let settled = false;
		let guard: ChildProcessTimeoutGuard | null = null;
		const finish = (error: ExecFileException | null, stdout: unknown, stderr: unknown): void => {
			if (settled) return;
			settled = true;
			guard?.settle();
			const normalizedStdout = String(stdout ?? "");
			const normalizedStderr = String(stderr ?? "");
			if (guard?.isTimedOut()) {
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
		};
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
			(error: ExecFileException | null, stdout, stderr) => finish(error, stdout, stderr),
		);
		// A failed/unsupported command can close its pipe before consuming input.
		child.stdin?.on("error", () => {});
		child.stdin?.end(stdin);

		if (!settled) {
			// The guard terminates, force-kills, and finally abandons a hung child, and
			// releases pipes a descendant keeps open, so no command holds its slot forever.
			guard = armChildProcessTimeout(child, timeoutMs, { onAbandoned: () => finish(null, "", "") });
		}
	});
}

/** Preserve global options when probing the repository used by a remote command. */
function remoteGitCommandPrefix(args: string[]): string[] | null {
	for (let index = 0; index < args.length; index += 1) {
		const arg = args[index];
		if (arg === undefined) return null;
		if (!arg.startsWith("-")) {
			return arg === "fetch" || arg === "pull" || arg === "push" ? args.slice(0, index) : null;
		}
		if (arg === "-c" || arg === "-C") index += 1;
	}
	return null;
}

async function remoteGitRepositoryKey(
	cwd: string,
	prefix: string[],
	env: NodeJS.ProcessEnv,
	priority: GitProcessPriority,
	signal?: AbortSignal,
): Promise<string> {
	// Use the process primitive directly: repository discovery must never enter
	// the remote queue, and must observe the same options and environment.
	const { stdout } = await executeGitCommand(
		cwd,
		buildGitCommandArgs([
			...prefix,
			"--no-optional-locks",
			"rev-parse",
			"--path-format=absolute",
			"--git-common-dir",
		]),
		env,
		GIT_COMMAND_TIMEOUTS_MS.metadata,
		priority,
		{ signal },
	);
	const commonDirectory = stdout.replace(/\r?\n$/u, "");
	if (!commonDirectory) throw new Error("Git remote command not started: shared Git directory is unavailable.");
	try {
		return normalizeFileSystemPathForComparison(await realpath(commonDirectory));
	} catch (cause) {
		throw new Error("Git remote command not started: shared Git directory could not be resolved.", { cause });
	}
}

export async function runGit(cwd: string, args: string[], options: RunGitOptions = {}): Promise<GitCommandResult> {
	try {
		const fullArgs = buildGitCommandArgs(args);
		const env = options.env || createGitProcessEnv();
		const priority = resolveGitProcessPriority(options);
		const execute = () =>
			executeGitCommand(cwd, fullArgs, env, resolveGitTimeoutMs(options), priority, {
				signal: options.signal,
				stdin: options.stdin,
			});
		const remotePrefix = remoteGitCommandPrefix(args);
		// Fetch, pull and push update remote refs shared across linked worktrees.
		// Admit one remote process per canonical common directory; inspections
		// remain concurrent and the command timeout begins only after admission.
		const { stdout, stderr } =
			remotePrefix === null
				? await execute()
				: await remoteGitCommands.run(
						await remoteGitRepositoryKey(cwd, remotePrefix, env, priority, options.signal),
						execute,
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
			terminatedBySignal: false,
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
		const exitCode = normalizeProcessExitCode(candidate.code);
		const errorMessage = timedOut
			? message.startsWith("Git command timed out after ")
				? message
				: timeoutMessage
			: exitCode < 0
				? message || stderr || "Unknown git error"
				: stderr || message || "Unknown git error";
		const errorCode = boundedGitErrorCode(candidate.code);
		const failureKind: GitCommandFailureKind =
			error instanceof GitLaunchAdmissionError
				? "launch_blocked"
				: error instanceof GitProcessAdmissionAbortedError
					? "aborted"
					: error instanceof GitProcessQueueTimeoutError
						? "queue_timed_out"
						: timedOut
							? "timed_out"
							: errorCode === "ENOENT"
								? "spawn_unavailable"
								: errorCode === "EACCES" || errorCode === "EPERM"
									? "permission_denied"
									: "command_failed";
		// Our own timeout termination also reports a signal (SIGTERM or SIGKILL);
		// only an external signal (e.g. an OOM killer's SIGKILL) outside that path counts.
		const terminatedBySignal = Boolean(candidate.signal) && !timedOut;

		return {
			ok: false,
			stdout,
			stderr,
			output: [stdout, stderr].filter(Boolean).join("\n"),
			error: errorMessage,
			exitCode,
			timedOut,
			terminatedBySignal,
			failureKind,
			errorCode,
		};
	}
}

/** Windows NTSTATUS failure codes (0xC0000000 and above) report a crashed or killed process, not Git's answer. */
const WINDOWS_NTSTATUS_ERROR_BASE = 0xc000_0000;
/** Spawn errors that report runtime resource exhaustion, not anything about the command or repository. */
const RESOURCE_EXHAUSTION_ERROR_CODES: ReadonlySet<GitCommandErrorCode> = new Set([
	"EAGAIN",
	"EMFILE",
	"ENFILE",
	"ENOMEM",
]);

/**
 * True when Git produced no answer: the command timed out or waited too long for
 * a process slot, was fenced or cancelled before launch, was killed by a signal
 * it did not get from us (for example an OOM kill), failed to spawn for resource
 * reasons (EAGAIN/EMFILE/ENFILE/ENOMEM), or otherwise ended without an exit
 * status. On Windows, spawn EPERM/EACCES (transient antivirus or handle
 * contention) and NTSTATUS exit codes are also indeterminate. Callers must not
 * read such a failure as a definite negative such as "not a repository".
 */
export function isGitCommandIndeterminate(
	result: Pick<GitCommandResult, "ok" | "timedOut" | "failureKind" | "exitCode" | "errorCode" | "terminatedBySignal">,
	platform: NodeJS.Platform = process.platform,
): boolean {
	if (result.ok) return false;
	if (
		result.timedOut ||
		result.failureKind === "timed_out" ||
		result.failureKind === "queue_timed_out" ||
		result.failureKind === "launch_blocked" ||
		result.failureKind === "aborted"
	) {
		return true;
	}
	if (platform === "win32") {
		if (result.failureKind === "permission_denied") return true;
		// -1 is this module's "no exit status" sentinel, never an NTSTATUS value.
		const exitStatus = result.exitCode === -1 ? 0 : result.exitCode >>> 0;
		if (result.failureKind === "command_failed" && exitStatus >= WINDOWS_NTSTATUS_ERROR_BASE) return true;
	}
	if (result.failureKind !== "command_failed") return false;
	if (result.terminatedBySignal) return true;
	if (result.errorCode && RESOURCE_EXHAUSTION_ERROR_CODES.has(result.errorCode)) return true;
	return result.exitCode < 0 && !result.errorCode;
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
 * Count commits reachable from the base but absent from HEAD, including merged history.
 * Compare the supplied ref exactly; callers choose local and remote refs separately.
 * Return null when the comparison cannot be established, never a fabricated zero.
 */
export async function getCommitsBehindBase(
	cwd: string,
	baseRef: string,
): Promise<{ behindCount: number; mergeBase: string } | null> {
	if (!validateGitRef(baseRef)) return null;
	const options = { timeoutClass: "metadata" } as const;
	const comparisonRef = baseRef.startsWith("origin/") ? `refs/remotes/${baseRef}` : baseRef;
	const resolved = await runGit(
		cwd,
		["--no-optional-locks", "rev-parse", "--verify", "--quiet", `${comparisonRef}^{commit}`],
		options,
	);
	if (!resolved.ok) return null;

	const [mergeBase, count] = await Promise.all([
		runGit(cwd, ["--no-optional-locks", "merge-base", "HEAD", resolved.stdout], options),
		runGit(cwd, ["--no-optional-locks", "rev-list", "--count", `HEAD..${resolved.stdout}`], options),
	]);
	if (!mergeBase.ok || !count.ok || !/^\d+$/u.test(count.stdout)) return null;
	const behindCount = Number(count.stdout);
	return Number.isSafeInteger(behindCount) ? { behindCount, mergeBase: mergeBase.stdout } : null;
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
 *
 * Runs on the `default` (5s) timeout class unless the caller supplies its own
 * class/timeout. Preflights nested inside a longer-running action (commit, stash,
 * merge, revert, cherry-pick) or a probe should pass that action's own timeout
 * class (or `inspection` for probes) so a slow Git under load gets the same
 * budget as the command that follows it.
 *
 * A timeout (or another indeterminate failure, such as a blocked launch or an
 * external signal death) never proves the directory isn't a repository, so it
 * surfaces as a distinct retryable error instead of the generic "no repository"
 * message.
 */
export async function resolveRepoRoot(cwd: string, options: RunGitOptions = {}): Promise<string> {
	const result = await runGit(cwd, ["--no-optional-locks", "rev-parse", "--show-toplevel"], options);
	if (!result.ok) {
		if (isGitCommandIndeterminate(result)) {
			throw new Error("Git did not respond in time; retry.");
		}
		throw new Error("No git repository detected for this project.");
	}
	if (!result.stdout) {
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
