import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { cp, lstat, mkdir, readdir, rename, rm } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";

function resolveGitCommonDirectory(repoRoot) {
	try {
		const output = execFileSync("git", ["rev-parse", "--git-common-dir"], {
			cwd: repoRoot,
			encoding: "utf8",
			stdio: ["ignore", "pipe", "ignore"],
		}).trim();
		return output ? resolve(repoRoot, output) : null;
	} catch {
		return null;
	}
}

/** Keep only Playwright's downloaded browser binaries in Git's shared common
 * directory. Unlike the old node_modules cache, this survives dependency
 * reinstalls while remaining scoped to this Quarterdeck clone. */
export function getAgentLabBrowserCachePaths(
	repoRoot,
	gitCommonDirectory = resolveGitCommonDirectory(repoRoot),
) {
	const normalizedCommonDirectory = gitCommonDirectory ? resolve(repoRoot, gitCommonDirectory) : null;
	const sharedRepoRoot =
		normalizedCommonDirectory && basename(normalizedCommonDirectory) === ".git"
			? dirname(normalizedCommonDirectory)
			: repoRoot;
	const stableRoot = normalizedCommonDirectory ?? join(repoRoot, ".quarterdeck-cache");
	return {
		stablePath: join(stableRoot, "quarterdeck", "agent-lab", "playwright-browsers"),
		legacyPath: join(sharedRepoRoot, "web-ui", "node_modules", ".cache", "agent-lab-playwright"),
	};
}

export function getAgentLabBrowserCachePath(
	repoRoot,
	gitCommonDirectory = resolveGitCommonDirectory(repoRoot),
) {
	return getAgentLabBrowserCachePaths(repoRoot, gitCommonDirectory).stablePath;
}

async function isCompleteLegacyBrowserCache(path) {
	const rootStat = await lstat(path).catch(() => null);
	if (!rootStat?.isDirectory() || rootStat.isSymbolicLink()) return false;

	let completeChromiumInstallations = 0;
	const pending = [path];
	let visitedEntries = 0;
	while (pending.length > 0) {
		const current = pending.pop();
		if (!current) continue;
		const entries = await readdir(current, { withFileTypes: true }).catch(() => null);
		if (!entries) return false;
		for (const entry of entries) {
			visitedEntries += 1;
			if (visitedEntries > 50_000 || entry.isSymbolicLink()) return false;
			if (entry.name.includes(".download") || entry.name.includes("__dirlock")) return false;
			const entryPath = join(current, entry.name);
			if (!entry.isDirectory()) continue;
			const isPlaywrightInstallation = /^(?:chromium|chromium_headless_shell|ffmpeg)-\d+$/.test(entry.name);
			if (isPlaywrightInstallation) {
				const markerStat = await lstat(join(entryPath, "INSTALLATION_COMPLETE")).catch(() => null);
				if (!markerStat?.isFile() || markerStat.isSymbolicLink()) return false;
				if (/^chromium(?:_headless_shell)?-\d+$/.test(entry.name)) {
					completeChromiumInstallations += 1;
				}
			}
			pending.push(entryPath);
		}
	}
	return completeChromiumInstallations > 0;
}

export async function prepareAgentLabBrowserCache(
	repoRoot,
	gitCommonDirectory = resolveGitCommonDirectory(repoRoot),
) {
	const paths = getAgentLabBrowserCachePaths(repoRoot, gitCommonDirectory);
	const stableStat = await lstat(paths.stablePath).catch(() => null);
	if (stableStat) {
		if (stableStat.isDirectory() && !stableStat.isSymbolicLink()) {
			return { path: paths.stablePath, status: "ready" };
		}
		throw new Error("Agent Lab's shared browser cache path must be a real directory, not a file or symlink.");
	}

	await mkdir(dirname(paths.stablePath), { recursive: true });
	if (!(await isCompleteLegacyBrowserCache(paths.legacyPath))) {
		await mkdir(paths.stablePath, { recursive: true });
		return { path: paths.stablePath, status: "empty" };
	}

	const stagingPath = `${paths.stablePath}.migrate-${process.pid}-${randomBytes(3).toString("hex")}`;
	try {
		await cp(paths.legacyPath, stagingPath, { recursive: true, dereference: false, errorOnExist: true });
		if (!(await isCompleteLegacyBrowserCache(stagingPath))) {
			throw new Error("Legacy Agent Lab browser cache changed during migration.");
		}
		try {
			await rename(stagingPath, paths.stablePath);
			return { path: paths.stablePath, status: "migrated" };
		} catch (error) {
			const destination = await lstat(paths.stablePath).catch(() => null);
			if (!destination?.isDirectory() || destination.isSymbolicLink()) throw error;
			return { path: paths.stablePath, status: "ready" };
		}
	} finally {
		await rm(stagingPath, { recursive: true, force: true });
	}
}
