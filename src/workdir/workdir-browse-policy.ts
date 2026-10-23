import { validateGitPath } from "./git-utils";
import { hasSkippedWorkdirPathComponent, normalizeWorkdirRelativePath } from "./workdir-path-policy";

/**
 * Browser view policy for directory listings and folder search. These rules decide
 * what is shown, never what may be mutated; mutation authority stays in
 * `workdir-path-policy.ts`.
 */

// Agent tools such as Claude Code create full linked worktrees here. Hide only this
// exact component sequence (at any depth), never `.claude` as a whole.
const GENERATED_WORKTREE_PARENT = ".claude";
const GENERATED_WORKTREE_CHILD = "worktrees";

export const WORKDIR_GENERATED_WORKTREE_HIDDEN_MESSAGE =
	"Generated agent worktrees are hidden. Show generated worktrees to browse them.";
export const WORKDIR_SKIPPED_DIRECTORY_BROWSE_MESSAGE = "VCS and dependency directories cannot be browsed.";

function comparablePathComponent(component: string, platform: NodeJS.Platform): string {
	return platform === "win32" ? component.toLowerCase() : component;
}

function lastPathComponent(path: string): string {
	return path.slice(path.lastIndexOf("/") + 1);
}

/** True when `<parentDirectory>/<name>` is a generated worktree container (`…/.claude/worktrees`). */
export function isGeneratedWorktreeContainer(
	parentDirectory: string,
	name: string,
	platform: NodeJS.Platform = process.platform,
): boolean {
	return (
		comparablePathComponent(name, platform) === GENERATED_WORKTREE_CHILD &&
		parentDirectory !== "" &&
		comparablePathComponent(lastPathComponent(parentDirectory), platform) === GENERATED_WORKTREE_PARENT
	);
}

/** True when a root-relative path is, or lies inside, a generated worktree container. */
export function isWithinGeneratedWorktreeContainer(
	relativePath: string,
	platform: NodeJS.Platform = process.platform,
): boolean {
	const components = relativePath.split("/").map((component) => comparablePathComponent(component, platform));
	for (let index = 1; index < components.length; index += 1) {
		if (components[index - 1] === GENERATED_WORKTREE_PARENT && components[index] === GENERATED_WORKTREE_CHILD) {
			return true;
		}
	}
	return false;
}

export interface WorkdirBrowseOptions {
	/** Reveals generated worktrees only; skipped VCS/dependency directories stay hidden. */
	showExcluded: boolean;
}

/** Whether a child directory is excluded from browsing before any Git ignore check. */
export function isBrowseExcludedChildDirectory(
	parentDirectory: string,
	name: string,
	options: WorkdirBrowseOptions,
	platform: NodeJS.Platform = process.platform,
): boolean {
	if (hasSkippedWorkdirPathComponent(name, platform)) return true;
	return !options.showExcluded && isGeneratedWorktreeContainer(parentDirectory, name, platform);
}

export type WorkdirBrowseDirectoryResult =
	| { readonly ok: true; readonly directory: string }
	| { readonly ok: false; readonly reason: "invalid" | "skipped" | "generated_worktree"; readonly message: string };

/** Normalizes a requested browse directory (`""` is the root) and applies view policy. */
export function resolveWorkdirBrowseDirectory(
	input: string | undefined,
	options: WorkdirBrowseOptions,
	platform: NodeJS.Platform = process.platform,
): WorkdirBrowseDirectoryResult {
	if (input === undefined || input === "") return { ok: true, directory: "" };
	let directory: string;
	try {
		directory = normalizeWorkdirRelativePath(input, platform);
	} catch (error) {
		return { ok: false, reason: "invalid", message: error instanceof Error ? error.message : "Invalid directory." };
	}
	if (!validateGitPath(directory, platform)) {
		return { ok: false, reason: "invalid", message: "Invalid directory." };
	}
	if (hasSkippedWorkdirPathComponent(directory, platform)) {
		return { ok: false, reason: "skipped", message: WORKDIR_SKIPPED_DIRECTORY_BROWSE_MESSAGE };
	}
	if (!options.showExcluded && isWithinGeneratedWorktreeContainer(directory, platform)) {
		return { ok: false, reason: "generated_worktree", message: WORKDIR_GENERATED_WORKTREE_HIDDEN_MESSAGE };
	}
	return { ok: true, directory };
}
