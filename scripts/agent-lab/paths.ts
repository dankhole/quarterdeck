import { randomBytes } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

import type { AgentLabBrowserCachePaths, AgentLabBrowserCachePreparation } from "./browser-cache.mjs";
import {
	prepareAgentLabBrowserCache as prepareSharedAgentLabBrowserCache,
	getAgentLabBrowserCachePath as resolveAgentLabBrowserCachePath,
	getAgentLabBrowserCachePaths as resolveAgentLabBrowserCachePaths,
} from "./browser-cache.mjs";
import { type ReadableAgentLabManifest, ReadableAgentLabManifestSchema } from "./types";

export const AGENT_LAB_REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
export const AGENT_LAB_BROWSER_INSTALL_COMMAND = "npm run agent:browser -- install-browser chromium";

export type { AgentLabBrowserCachePaths, AgentLabBrowserCachePreparation };

export function getAgentLabBrowserCachePaths(
	repoRoot = AGENT_LAB_REPO_ROOT,
	gitCommonDirectory?: string | null,
): AgentLabBrowserCachePaths {
	return gitCommonDirectory === undefined
		? resolveAgentLabBrowserCachePaths(repoRoot)
		: resolveAgentLabBrowserCachePaths(repoRoot, gitCommonDirectory);
}

export function getAgentLabBrowserCachePath(
	repoRoot = AGENT_LAB_REPO_ROOT,
	gitCommonDirectory?: string | null,
): string {
	return gitCommonDirectory === undefined
		? resolveAgentLabBrowserCachePath(repoRoot)
		: resolveAgentLabBrowserCachePath(repoRoot, gitCommonDirectory);
}

export function prepareAgentLabBrowserCache(
	repoRoot = AGENT_LAB_REPO_ROOT,
	gitCommonDirectory?: string | null,
): Promise<{ path: string; status: AgentLabBrowserCachePreparation }> {
	return gitCommonDirectory === undefined
		? prepareSharedAgentLabBrowserCache(repoRoot)
		: prepareSharedAgentLabBrowserCache(repoRoot, gitCommonDirectory);
}

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
