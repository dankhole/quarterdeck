import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { cp, lstat, mkdir, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

import { type ReadableAgentLabManifest, ReadableAgentLabManifestSchema } from "./types";

export const AGENT_LAB_REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
export const AGENT_LAB_BROWSER_INSTALL_COMMAND = "npm run agent:browser -- install-browser chromium";

export function getAgentLabArtifactRoot(repoRoot = AGENT_LAB_REPO_ROOT): string {
	const override = process.env.QUARTERDECK_AGENT_LAB_ARTIFACT_ROOT?.trim();
	return override ? resolve(override) : join(repoRoot, "test-results", "agent-lab");
}

export function getAgentBrowserLocalPaths(repoRoot = AGENT_LAB_REPO_ROOT): {
	artifactRoot: string;
	browserHomePath: string;
	daemonSessionPath: string;
} {
	const artifactRoot = getAgentLabArtifactRoot(repoRoot);
	return {
		artifactRoot,
		browserHomePath: join(artifactRoot, "browser-home"),
		daemonSessionPath: join(artifactRoot, "browser-daemon"),
	};
}

function resolveGitCommonDirectory(repoRoot: string): string | null {
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

export interface AgentLabBrowserCachePaths {
	stablePath: string;
	legacyPath: string;
}

/** Keep only Playwright's downloaded browser binaries in Git's shared common
 * directory. Unlike the old node_modules cache, this survives dependency
 * reinstalls while remaining scoped to this Quarterdeck clone. */
export function getAgentLabBrowserCachePaths(
	repoRoot = AGENT_LAB_REPO_ROOT,
	gitCommonDirectory = resolveGitCommonDirectory(repoRoot),
): AgentLabBrowserCachePaths {
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
	repoRoot = AGENT_LAB_REPO_ROOT,
	gitCommonDirectory = resolveGitCommonDirectory(repoRoot),
): string {
	return getAgentLabBrowserCachePaths(repoRoot, gitCommonDirectory).stablePath;
}

async function isCompleteLegacyBrowserCache(path: string): Promise<boolean> {
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

export type AgentLabBrowserCachePreparation = "ready" | "migrated" | "empty";

export async function prepareAgentLabBrowserCache(
	repoRoot = AGENT_LAB_REPO_ROOT,
	gitCommonDirectory = resolveGitCommonDirectory(repoRoot),
): Promise<{ path: string; status: AgentLabBrowserCachePreparation }> {
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

function sanitizeRunName(value: string): string {
	const sanitized = value
		.trim()
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "")
		.slice(0, 40);
	return sanitized || "run";
}

export function createAgentLabRunId(name = "run", now = new Date()): string {
	const timestamp = now
		.toISOString()
		.replace(/[-:]/g, "")
		.replace(/\.\d{3}Z$/, "Z");
	return `${sanitizeRunName(name)}-${timestamp}-${randomBytes(3).toString("hex")}`;
}

export function assertSafeRunId(runId: string): string {
	if (!/^[a-z0-9][a-z0-9-]{0,100}$/i.test(runId)) {
		throw new Error(`Invalid agent-lab run id: ${JSON.stringify(runId)}`);
	}
	return runId;
}

export function resolveRunArtifactDir(runId: string, artifactRoot = getAgentLabArtifactRoot()): string {
	const safeRunId = assertSafeRunId(runId);
	const resolvedRoot = resolve(artifactRoot);
	const artifactDir = resolve(resolvedRoot, safeRunId);
	if (artifactDir !== resolvedRoot && !artifactDir.startsWith(`${resolvedRoot}${sep}`)) {
		throw new Error(`Agent-lab artifact path escaped its root: ${artifactDir}`);
	}
	return artifactDir;
}

export async function writeJsonAtomic(path: string, value: unknown): Promise<void> {
	await mkdir(dirname(path), { recursive: true });
	const temporaryPath = `${path}.tmp-${process.pid}-${randomBytes(3).toString("hex")}`;
	await writeFile(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
	await rename(temporaryPath, path);
}

export async function readAgentLabManifest(path: string): Promise<ReadableAgentLabManifest> {
	const contents = await readFile(path, "utf8");
	return ReadableAgentLabManifestSchema.parse(JSON.parse(contents) as unknown);
}

export function isProcessAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return typeof error === "object" && error !== null && "code" in error && error.code === "EPERM";
	}
}
