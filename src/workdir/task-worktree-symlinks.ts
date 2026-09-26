import { constants } from "node:fs";
import { access, copyFile, lstat, mkdir, readdir, readFile, unlink } from "node:fs/promises";
import { isAbsolute, join } from "node:path";

import ignore from "ignore";

import { isNodeError, lockedFileSystem } from "../fs";
import { getGitStdout, runGit, splitNullSeparatedGitOutput } from "./git-utils";

const QUARTERDECK_MANAGED_EXCLUDE_BLOCK_START = "# quarterdeck-managed-symlinked-ignored-paths:start";
const QUARTERDECK_MANAGED_EXCLUDE_BLOCK_END = "# quarterdeck-managed-symlinked-ignored-paths:end";
const USER_GIT_ACTION_OPTIONS = { timeoutClass: "userAction" } as const;

const SYMLINK_PATH_SEGMENT_BLACKLIST_VALUES = [
	".git",
	".DS_Store",
	"Thumbs.db",
	"Desktop.ini",
	"Icon\r",
	".Spotlight-V100",
	".Trashes",
] as const;
const SYMLINK_PATH_SEGMENT_BLACKLIST = new Set<string>(SYMLINK_PATH_SEGMENT_BLACKLIST_VALUES);
const WINDOWS_SYMLINK_PATH_SEGMENT_BLACKLIST = new Set<string>(
	SYMLINK_PATH_SEGMENT_BLACKLIST_VALUES.map((segment) => segment.toLowerCase()),
);
const MUTABLE_WORKTREE_SEGMENT_BLACKLIST = new Set([
	".agent-lab-results",
	"bin",
	"node_modules",
	"obj",
	"playwright-report",
	"test-results",
	"testresults",
]);

export async function pathExists(path: string): Promise<boolean> {
	try {
		await access(path);
		return true;
	} catch {
		return false;
	}
}

function toPlatformRelativePath(path: string): string {
	return path
		.replace(/\/+$/g, "")
		.split("/")
		.filter((segment) => segment.length > 0)
		.join("/");
}

export function shouldSkipWorktreeCopy(relativePath: string, platform: NodeJS.Platform = process.platform): boolean {
	const segments = relativePath.split("/").filter((segment) => segment.length > 0);
	if (segments.length === 0) {
		return true;
	}
	return segments.some(
		(segment) =>
			(platform === "win32"
				? WINDOWS_SYMLINK_PATH_SEGMENT_BLACKLIST.has(segment.toLowerCase())
				: SYMLINK_PATH_SEGMENT_BLACKLIST.has(segment)) ||
			MUTABLE_WORKTREE_SEGMENT_BLACKLIST.has(segment.toLowerCase()),
	);
}

function isPathWithinRoot(path: string, root: string, platform: NodeJS.Platform): boolean {
	if (platform === "win32") {
		path = path.toLowerCase();
		root = root.toLowerCase();
	}
	return path === root || path.startsWith(`${root}/`);
}

export function getUniquePaths(relativePaths: string[], platform: NodeJS.Platform = process.platform): string[] {
	const uniqueByIdentity = new Map<string, string>();
	for (const path of relativePaths.map((entry) => toPlatformRelativePath(entry)).filter(Boolean)) {
		const identity = platform === "win32" ? path.toLowerCase() : path;
		if (!uniqueByIdentity.has(identity)) uniqueByIdentity.set(identity, path);
	}
	const uniquePaths = Array.from(uniqueByIdentity.values());
	uniquePaths.sort((left, right) => {
		const leftDepth = left.split("/").length;
		const rightDepth = right.split("/").length;
		if (leftDepth !== rightDepth) {
			return leftDepth - rightDepth;
		}
		return left.localeCompare(right);
	});

	const roots: string[] = [];
	for (const path of uniquePaths) {
		if (roots.some((root) => isPathWithinRoot(path, root, platform))) {
			continue;
		}
		roots.push(path);
	}

	return roots;
}

async function listIgnoredPaths(repoPath: string): Promise<string[]> {
	const output = await getGitStdout(
		["ls-files", "--others", "--ignored", "--exclude-standard", "--directory", "-z"],
		repoPath,
		{ trimStdout: false, ...USER_GIT_ACTION_OPTIONS },
	);
	return splitNullSeparatedGitOutput(output)
		.map((line) => toPlatformRelativePath(line))
		.filter((line) => line.length > 0);
}

function escapeGitIgnoreLiteral(path: string): string {
	const normalized = toPlatformRelativePath(path);
	return normalized
		.replace(/\\/g, "\\\\")
		.replace(/^([#!])/u, "\\$1")
		.replace(/([*?[])/g, "\\$1")
		.replace(/ +$/u, (spaces) => spaces.replaceAll(" ", "\\ "));
}

function stripManagedExcludeBlock(content: string): string {
	const lines = content.split(/\r?\n/u);
	const nextLines: string[] = [];
	let insideManagedBlock = false;
	for (const line of lines) {
		if (line === QUARTERDECK_MANAGED_EXCLUDE_BLOCK_START) {
			insideManagedBlock = true;
			continue;
		}
		if (line === QUARTERDECK_MANAGED_EXCLUDE_BLOCK_END) {
			insideManagedBlock = false;
			continue;
		}
		if (!insideManagedBlock) {
			nextLines.push(line);
		}
	}
	return nextLines.join("\n").replace(/\n+$/g, "");
}

async function syncManagedIgnoredPathExcludes(repoPath: string, relativePaths: string[]): Promise<void> {
	const excludePathOutput = await getGitStdout(
		["rev-parse", "--git-path", "info/exclude"],
		repoPath,
		USER_GIT_ACTION_OPTIONS,
	);
	if (!excludePathOutput) {
		return;
	}
	const excludePath = isAbsolute(excludePathOutput) ? excludePathOutput : join(repoPath, excludePathOutput);

	await lockedFileSystem.withLock({ path: excludePath }, async () => {
		const existingContent = await readFile(excludePath, "utf8").catch((error: unknown) => {
			if (isNodeError(error, "ENOENT")) return "";
			throw error;
		});
		const preservedContent = stripManagedExcludeBlock(existingContent);
		// Excludes are shared by Git worktrees. Preserve earlier copied and legacy
		// mirrored paths so creating another task cannot expose their ignored files.
		const oldManagedBlock =
			existingContent
				.split(QUARTERDECK_MANAGED_EXCLUDE_BLOCK_START)[1]
				?.split(QUARTERDECK_MANAGED_EXCLUDE_BLOCK_END)[0] ?? "";
		const managedPatterns = new Set([
			...oldManagedBlock.split(/\r?\n/u).filter((line) => line.startsWith("/")),
			...relativePaths.map((relativePath) => `/${escapeGitIgnoreLiteral(relativePath)}`),
		]);
		const managedBlock =
			managedPatterns.size === 0
				? ""
				: [
						QUARTERDECK_MANAGED_EXCLUDE_BLOCK_START,
						"# Keep included ignored files ignored inside Quarterdeck task worktrees.",
						...managedPatterns,
						QUARTERDECK_MANAGED_EXCLUDE_BLOCK_END,
					].join("\n");

		const nextContent = [preservedContent, managedBlock].filter(Boolean).join("\n\n").replace(/\n+$/g, "");
		const normalizedNextContent = nextContent ? `${nextContent}\n` : "";
		if (normalizedNextContent === existingContent) {
			return;
		}

		await lockedFileSystem.writeTextFileAtomic(excludePath, normalizedNextContent, { lock: null });
	});
}

/** Do not follow directory links, including legacy ignored-directory mirrors. */
async function hasRealDirectoryAncestors(rootPath: string, relativePath: string, create: boolean): Promise<boolean> {
	let currentPath = rootPath;
	for (const segment of relativePath.split("/").slice(0, -1)) {
		currentPath = join(currentPath, segment);
		let stat = await lstatIfPresent(currentPath);
		if (!stat && create) {
			await mkdir(currentPath).catch((error: unknown) => {
				if (!isNodeError(error, "EEXIST")) throw error;
			});
			stat = await lstatIfPresent(currentPath);
		}
		if (!stat?.isDirectory() || stat.isSymbolicLink()) return false;
	}
	return true;
}

async function lstatIfPresent(path: string) {
	try {
		return await lstat(path);
	} catch (error) {
		if (isNodeError(error, "ENOENT") || isNodeError(error, "ENOTDIR")) return null;
		throw error;
	}
}

/** Remove only dependency links themselves; preserve local installs and every linked target. */
export async function cleanupLegacyDependencySymlinks(worktreePath: string): Promise<void> {
	async function visit(directory: string): Promise<void> {
		for (const entry of await readdir(directory, { withFileTypes: true })) {
			const path = join(directory, entry.name);
			if (entry.name.toLowerCase() === "node_modules") {
				if ((await lstatIfPresent(path))?.isSymbolicLink()) await unlink(path);
				continue;
			}
			if (entry.isDirectory() && !shouldSkipWorktreeCopy(entry.name)) await visit(path);
		}
	}
	if ((await lstatIfPresent(worktreePath))?.isDirectory()) await visit(worktreePath);
}

/** Copy explicitly included, Git-ignored regular files once when preparing a new worktree. */
export async function copyIncludedIgnoredPathsIntoWorktree(repoPath: string, worktreePath: string): Promise<void> {
	const includePath = join(repoPath, ".worktreeinclude");
	if (!(await lstatIfPresent(includePath))?.isFile()) return;
	const include = ignore({ ignorecase: process.platform === "win32" }).add(await readFile(includePath, "utf8"));
	const includedPaths: string[] = [];

	async function visit(relativePath: string): Promise<void> {
		if (shouldSkipWorktreeCopy(relativePath)) return;
		if (!(await hasRealDirectoryAncestors(repoPath, relativePath, false))) return;
		const sourcePath = join(repoPath, relativePath);
		const sourceStat = await lstatIfPresent(sourcePath);
		if (!sourceStat || sourceStat.isSymbolicLink()) return;
		if (sourceStat.isDirectory()) {
			for (const entry of await readdir(sourcePath)) await visit(`${relativePath}/${entry}`);
			return;
		}
		if (!sourceStat.isFile() || !include.ignores(relativePath)) return;
		if (/[\r\n]/u.test(relativePath)) {
			throw new Error(
				"An included file has a newline in its name, which Git ignore rules cannot preserve. Exclude or rename that file before retrying worktree setup.",
			);
		}
		if (!(await hasRealDirectoryAncestors(worktreePath, relativePath, true))) return;
		const targetPath = join(worktreePath, relativePath);
		const targetStat = await lstatIfPresent(targetPath);
		if (targetStat) {
			// A retry after partial preparation must also repair ignore metadata
			// for copies that were already completed, without replacing their data.
			if (targetStat.isFile()) includedPaths.push(relativePath);
			return;
		}
		try {
			await copyFile(sourcePath, targetPath, constants.COPYFILE_EXCL);
			includedPaths.push(relativePath);
		} catch (error) {
			if (isNodeError(error, "EEXIST")) return;
			throw new Error(
				`Could not copy included file "${relativePath}" into the task worktree. Check source readability and worktree write permissions, then retry.`,
				{ cause: error },
			);
		}
	}

	// Git identifies ignored roots using repository, nested, info/exclude and
	// global rules. Traverse those roots ourselves to prune dependencies and links.
	try {
		for (const relativePath of getUniquePaths(await listIgnoredPaths(repoPath))) await visit(relativePath);
	} finally {
		// A partial copy must stay ignored even if a later selected file fails.
		if (includedPaths.length > 0) await syncManagedIgnoredPathExcludes(repoPath, includedPaths);
	}
}

async function worktreeHasConfiguredSubmodules(worktreePath: string): Promise<boolean> {
	const gitmodulesPath = join(worktreePath, ".gitmodules");
	if (!(await pathExists(gitmodulesPath))) {
		return false;
	}

	const result = await runGit(
		worktreePath,
		["config", "--file", gitmodulesPath, "--get-regexp", "^submodule\\..*\\.path$"],
		USER_GIT_ACTION_OPTIONS,
	);
	return result.ok && result.stdout.length > 0;
}

export async function initializeSubmodulesIfNeeded(worktreePath: string): Promise<void> {
	if (!(await worktreeHasConfiguredSubmodules(worktreePath))) {
		return;
	}

	await getGitStdout(["submodule", "update", "--init", "--recursive"], worktreePath, USER_GIT_ACTION_OPTIONS);
}
