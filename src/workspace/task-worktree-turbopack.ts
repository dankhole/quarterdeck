import { cp, lstat, readFile, readdir, rename, rm } from "node:fs/promises";
import { join } from "node:path";

const NODE_MODULES_RELATIVE_PATH = "node_modules";
const TURBOPACK_SCAN_MAX_DIRECTORY_DEPTH = 3;
const TURBOPACK_SCRIPT_FLAG_PATTERN = /(^|\s)--(?:turbo|turbopack)(?=\s|$)/i;
const TURBOPACK_SCRIPT_ENV_PATTERN = /(^|\s)(?:TURBOPACK|NEXT_TURBOPACK)\s*=\s*(?:1|true|yes)(?=\s|$)/i;
const TURBOPACK_CONFIG_PATTERN = /\bturbopack\b/i;
const NEXT_SCRIPT_PATTERN = /\bnext\b/i;
const NEXT_CONFIG_FILENAMES = [
	"next.config.js",
	"next.config.mjs",
	"next.config.cjs",
	"next.config.ts",
	"next.config.mts",
	"next.config.cts",
];
const TURBOPACK_SCAN_DIRECTORY_SKIP = new Set([".git", ".next", "build", "coverage", "dist", "node_modules"]);

const nodeModulesCopyReplacementInFlight = new Set<string>();

/*
We keep ignored paths symlinked by default because creating full copies can make task startup slow.
Turbopack is a special case because it rejects node_modules symlink targets that resolve outside the project root.
We previously explored fully copying node_modules during worktree setup and reflink-based copies.
Full copies are too expensive for large dependency trees and noticeably hurt task startup.
Reflinks are not consistently available across filesystems and platforms, so behavior is unreliable.
Current strategy:
- create the node_modules symlink immediately so task setup stays fast
- only when Turbopack is detected, copy node_modules in the background
- atomically swap the symlink for the copied directory when the copy finishes
This keeps non-Turbopack projects fast while avoiding Turbopack runtime failures in the common case.
Tradeoffs and intended semantics:
- this is optimistic eventual consistency, not a hard readiness guarantee; task worktree setup returns before the copy finishes, and we accept a small window where the first Turbopack launch could still race the replacement in exchange for fast task startup
- after the swap, node_modules is an isolated snapshot seeded from the repo root at copy time; later installs in the main repo do not automatically refresh existing task worktrees, and task worktree changes do not propagate back to the main repo
- Turbopack detection is intentionally heuristic; we check the repo root first, then do a shallow scan for nested package directories up to a few levels deep, and inspect only those package roots for package.json script hints plus local next.config.* files
- custom launch flows or deeper non-standard layouts may still be missed, which is acceptable for now because this is a broad best-effort heuristic rather than a full project graph resolver
*/

interface PackageJsonShape {
	scripts?: Record<string, unknown>;
	dependencies?: Record<string, unknown>;
	devDependencies?: Record<string, unknown>;
	peerDependencies?: Record<string, unknown>;
}

function toPlatformRelativePath(path: string): string {
	return path
		.trim()
		.replaceAll("\\", "/")
		.replace(/\/+$/g, "")
		.split("/")
		.filter((segment) => segment.length > 0)
		.join("/");
}

function isRootNodeModulesPath(relativePath: string): boolean {
	return toPlatformRelativePath(relativePath) === NODE_MODULES_RELATIVE_PATH;
}

function scriptUsesTurbopack(script: string): boolean {
	return TURBOPACK_SCRIPT_FLAG_PATTERN.test(script) || TURBOPACK_SCRIPT_ENV_PATTERN.test(script);
}

function isObjectRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

function getStringScripts(packageJson: PackageJsonShape): string[] {
	const scripts = packageJson.scripts;
	if (!isObjectRecord(scripts)) {
		return [];
	}

	return Object.values(scripts).filter((script): script is string => typeof script === "string");
}

function packageDependsOnNext(packageJson: PackageJsonShape): boolean {
	for (const dependencyGroup of [
		packageJson.dependencies,
		packageJson.devDependencies,
		packageJson.peerDependencies,
	]) {
		if (!isObjectRecord(dependencyGroup)) {
			continue;
		}

		if ("next" in dependencyGroup) {
			return true;
		}
	}

	return false;
}

function packageLooksLikeNextApp(packageJson: PackageJsonShape): boolean {
	return packageDependsOnNext(packageJson) || getStringScripts(packageJson).some((script) => NEXT_SCRIPT_PATTERN.test(script));
}

async function readPackageJson(packageDir: string): Promise<PackageJsonShape | null> {
	try {
		const packageJsonContent = await readFile(join(packageDir, "package.json"), "utf8");
		return JSON.parse(packageJsonContent) as PackageJsonShape;
	} catch {
		return null;
	}
}

async function repoConfigMentionsTurbopack(repoPath: string): Promise<boolean> {
	for (const filename of NEXT_CONFIG_FILENAMES) {
		try {
			const content = await readFile(join(repoPath, filename), "utf8");
			if (TURBOPACK_CONFIG_PATTERN.test(content)) {
				return true;
			}
		} catch {}
	}

	return false;
}

async function packageDirectoryUsesTurbopack(packageDir: string): Promise<boolean> {
	const packageJson = await readPackageJson(packageDir);
	if (!packageJson) {
		return false;
	}

	const scripts = getStringScripts(packageJson);
	if (scripts.some((script) => scriptUsesTurbopack(script))) {
		return true;
	}

	if (!packageLooksLikeNextApp(packageJson)) {
		return false;
	}

	return await repoConfigMentionsTurbopack(packageDir);
}

async function collectNestedPackageDirs(rootDir: string): Promise<string[]> {
	const packageDirs: string[] = [];

	// This is a bounded directory walk, not a repo-wide content scan.
	// We only look for package roots by checking whether visited directories contain package.json.
	// Turbopack heuristics are evaluated only for those package roots and their local next.config.* files.
	async function visitDirectory(currentDir: string, depth: number): Promise<void> {
		if (depth >= TURBOPACK_SCAN_MAX_DIRECTORY_DEPTH) {
			return;
		}

		const entries = await readdir(currentDir, { withFileTypes: true }).catch(() => []);
		for (const entry of entries) {
			if (!entry.isDirectory() || TURBOPACK_SCAN_DIRECTORY_SKIP.has(entry.name)) {
				continue;
			}

			const childDir = join(currentDir, entry.name);
			if ((await readPackageJson(childDir)) !== null) {
				packageDirs.push(childDir);
			}

			await visitDirectory(childDir, depth + 1);
		}
	}

	await visitDirectory(rootDir, 0);
	return packageDirs;
}

export async function repoUsesTurbopack(repoPath: string): Promise<boolean> {
	if (await packageDirectoryUsesTurbopack(repoPath)) {
		return true;
	}

	for (const packageDir of await collectNestedPackageDirs(repoPath)) {
		if (await packageDirectoryUsesTurbopack(packageDir)) {
			return true;
		}
	}

	return false;
}

function buildNodeModulesSwapPath(targetPath: string, suffixType: "copy" | "backup"): string {
	const operationId = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
	return `${targetPath}.kanban-node-modules-${suffixType}-${operationId}`;
}

async function replaceNodeModulesSymlinkWithCopy(options: { sourcePath: string; targetPath: string }): Promise<void> {
	const targetStat = await lstat(options.targetPath).catch(() => null);
	if (!targetStat?.isSymbolicLink()) {
		return;
	}

	const sourceStat = await lstat(options.sourcePath).catch(() => null);
	if (!sourceStat?.isDirectory()) {
		return;
	}

	const copyPath = buildNodeModulesSwapPath(options.targetPath, "copy");
	const backupPath = buildNodeModulesSwapPath(options.targetPath, "backup");
	try {
		await cp(options.sourcePath, copyPath, { recursive: true });
		await rename(options.targetPath, backupPath);
		try {
			await rename(copyPath, options.targetPath);
		} catch (error) {
			await rename(backupPath, options.targetPath).catch(() => {});
			throw error;
		}
		await rm(backupPath, { recursive: true, force: true });
	} finally {
		await rm(copyPath, { recursive: true, force: true }).catch(() => {});
	}
}

export function scheduleNodeModulesCopyReplacementIfNeeded(options: {
	usesTurbopack: boolean;
	relativePath: string;
	sourcePath: string;
	targetPath: string;
}): void {
	if (!options.usesTurbopack || !isRootNodeModulesPath(options.relativePath)) {
		return;
	}

	if (nodeModulesCopyReplacementInFlight.has(options.targetPath)) {
		return;
	}

	nodeModulesCopyReplacementInFlight.add(options.targetPath);
	void replaceNodeModulesSymlinkWithCopy({
		sourcePath: options.sourcePath,
		targetPath: options.targetPath,
	})
		.catch(() => {})
		.finally(() => {
			nodeModulesCopyReplacementInFlight.delete(options.targetPath);
		});
}
