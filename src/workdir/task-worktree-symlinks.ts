import { constants } from "node:fs";
import { access, copyFile, lstat, mkdir, readFile, symlink, unlink } from "node:fs/promises";
import { dirname, isAbsolute, join } from "node:path";

import { lockedFileSystem } from "../fs";
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

type CreateSymlink = (target: string, path: string, type: "dir" | "file" | "junction") => Promise<void>;
type CopyFile = (source: string, destination: string, mode?: number) => Promise<void>;

export class IgnoredPathMirrorError extends Error {
	readonly code = "IGNORED_PATH_MIRROR_FAILED";

	constructor(
		readonly sourcePath: string,
		readonly targetPath: string,
		readonly pathKind: "directory" | "file",
	) {
		super(
			`Quarterdeck could not mirror ignored ${pathKind} "${sourcePath}" into the task worktree at "${targetPath}". Check that the source is readable and the task worktree is writable, then retry.`,
		);
		this.name = "IgnoredPathMirrorError";
	}
}

export async function pathExists(path: string): Promise<boolean> {
	try {
		await access(path);
		return true;
	} catch {
		return false;
	}
}

export async function mirrorIgnoredPath(options: {
	sourcePath: string;
	targetPath: string;
	isDirectory: boolean;
	createSymlink?: CreateSymlink;
	copyFile?: CopyFile;
	platform?: NodeJS.Platform;
}): Promise<"copied" | "mirrored"> {
	const createSymlink = options.createSymlink ?? symlink;
	const copyIgnoredFile = options.copyFile ?? copyFile;
	const platform = options.platform ?? process.platform;
	try {
		// On Windows, use junctions for directories — they don't require admin/Developer Mode.
		const symlinkType = options.isDirectory ? (platform === "win32" ? "junction" : "dir") : "file";
		await createSymlink(options.sourcePath, options.targetPath, symlinkType);
		return "mirrored";
	} catch {
		// Windows commonly denies file symlinks unless Developer Mode or the
		// symlink privilege is enabled. An exclusive task-local copy is a safer
		// fallback than a hard link because task writes cannot mutate the source.
		if (platform === "win32" && !options.isDirectory) {
			try {
				await copyIgnoredFile(options.sourcePath, options.targetPath, constants.COPYFILE_EXCL);
				return "copied";
			} catch {
				throw new IgnoredPathMirrorError(options.sourcePath, options.targetPath, "file");
			}
		}

		throw new IgnoredPathMirrorError(
			options.sourcePath,
			options.targetPath,
			options.isDirectory ? "directory" : "file",
		);
	}
}

function toPlatformRelativePath(path: string): string {
	return path
		.replace(/\r$/u, "")
		.replaceAll("\\", "/")
		.replace(/\/+$/g, "")
		.split("/")
		.filter((segment) => segment.length > 0)
		.join("/");
}

export function shouldSkipSymlink(relativePath: string, platform: NodeJS.Platform = process.platform): boolean {
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

function isInstalledDependencyPath(relativePath: string): boolean {
	return relativePath
		.split("/")
		.filter(Boolean)
		.some((segment) => segment.toLowerCase() === "node_modules");
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
		["ls-files", "--others", "--ignored", "--exclude-per-directory=.gitignore", "--directory", "-z"],
		repoPath,
		{ trimStdout: false, ...USER_GIT_ACTION_OPTIONS },
	);
	return splitNullSeparatedGitOutput(output)
		.map((line) => toPlatformRelativePath(line))
		.filter((line) => line.length > 0);
}

async function listUntrackedPaths(repoPath: string): Promise<string[]> {
	const output = await getGitStdout(["ls-files", "--others", "--directory", "-z"], repoPath, {
		trimStdout: false,
		...USER_GIT_ACTION_OPTIONS,
	});
	return splitNullSeparatedGitOutput(output)
		.map((line) => toPlatformRelativePath(line))
		.filter((line) => line.length > 0);
}

function escapeGitIgnoreLiteral(path: string): string {
	const normalized = toPlatformRelativePath(path);
	return normalized
		.replace(/\\/g, "\\\\")
		.replace(/^([#!])/u, "\\$1")
		.replace(/([*?[])/g, "\\$1");
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

	const existingContent = await readFile(excludePath, "utf8").catch(() => "");
	const preservedContent = stripManagedExcludeBlock(existingContent);
	const managedPaths = getUniquePaths(relativePaths);
	const managedBlock =
		managedPaths.length === 0
			? ""
			: [
					QUARTERDECK_MANAGED_EXCLUDE_BLOCK_START,
					"# Keep symlinked ignored paths ignored inside Quarterdeck task worktrees.",
					...managedPaths.map((relativePath) => `/${escapeGitIgnoreLiteral(relativePath)}`),
					QUARTERDECK_MANAGED_EXCLUDE_BLOCK_END,
				].join("\n");

	const nextContent = [preservedContent, managedBlock].filter(Boolean).join("\n\n").replace(/\n+$/g, "");
	const normalizedNextContent = nextContent ? `${nextContent}\n` : "";
	if (normalizedNextContent === existingContent) {
		return;
	}

	await lockedFileSystem.writeTextFileAtomic(excludePath, normalizedNextContent);
}

export async function syncIgnoredPathsIntoWorktree(repoPath: string, worktreePath: string): Promise<void> {
	const ignoredPaths = getUniquePaths(await listIgnoredPaths(repoPath));
	const [worktreeIgnoredPaths, worktreeUntrackedPaths] = await Promise.all([
		listIgnoredPaths(worktreePath),
		listUntrackedPaths(worktreePath),
	]);
	const installedDependencyPaths = getUniquePaths([
		...ignoredPaths,
		...worktreeIgnoredPaths,
		...worktreeUntrackedPaths,
	]).filter(isInstalledDependencyPath);

	// Older Quarterdeck versions mirrored node_modules into task worktrees. Remove
	// only those worktree-local links during the next ensure/start; never recurse
	// into or mutate the dependency tree they reference. Real local directories are
	// preserved so a task can install and own its dependencies independently.
	for (const relativePath of installedDependencyPaths) {
		const targetPath = join(worktreePath, relativePath);
		const targetStat = await lstat(targetPath).catch(() => null);
		if (targetStat?.isSymbolicLink()) {
			await unlink(targetPath);
		}
	}

	const mirroredIgnoredPaths = ignoredPaths.filter((relativePath) => !shouldSkipSymlink(relativePath));

	await syncManagedIgnoredPathExcludes(repoPath, mirroredIgnoredPaths);
	for (const relativePath of mirroredIgnoredPaths) {
		if (shouldSkipSymlink(relativePath)) {
			continue;
		}

		const sourcePath = join(repoPath, relativePath);
		if (!(await pathExists(sourcePath))) {
			continue;
		}

		const targetPath = join(worktreePath, relativePath);
		if (await pathExists(targetPath)) {
			continue;
		}

		const sourceStat = await lstat(sourcePath);
		await mkdir(dirname(targetPath), { recursive: true });
		await mirrorIgnoredPath({
			sourcePath,
			targetPath,
			isDirectory: sourceStat.isDirectory(),
		});
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
