import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

import { type ReadableAgentLabManifest, ReadableAgentLabManifestSchema } from "./types";

export const AGENT_LAB_REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

export function getAgentLabArtifactRoot(repoRoot = AGENT_LAB_REPO_ROOT): string {
	const override = process.env.QUARTERDECK_AGENT_LAB_ARTIFACT_ROOT?.trim();
	return override ? resolve(override) : join(repoRoot, "test-results", "agent-lab");
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

/**
 * Keep the large Playwright browser download in the primary checkout so all
 * linked worktrees for this clone reuse it. Source archives and unusual Git
 * layouts safely fall back to the active checkout's ignored node_modules.
 */
export function getAgentLabBrowserCachePath(
	repoRoot = AGENT_LAB_REPO_ROOT,
	gitCommonDirectory = resolveGitCommonDirectory(repoRoot),
): string {
	const normalizedCommonDirectory = gitCommonDirectory ? resolve(repoRoot, gitCommonDirectory) : null;
	const sharedRepoRoot =
		normalizedCommonDirectory && basename(normalizedCommonDirectory) === ".git"
			? dirname(normalizedCommonDirectory)
			: repoRoot;
	return join(sharedRepoRoot, "web-ui", "node_modules", ".cache", "agent-lab-playwright");
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
