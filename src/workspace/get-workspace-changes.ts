import { readFile } from "node:fs/promises";
import { join } from "node:path";

import type {
	RuntimeWorkspaceChangesResponse,
	RuntimeWorkspaceFileChange,
	RuntimeWorkspaceFileStatus,
} from "../core/api-contract";
import type { FileFingerprint } from "./file-fingerprint";
import { buildFileFingerprints } from "./file-fingerprint";
import { countLines, getGitStdout, resolveRepoRoot } from "./git-utils";

const WORKSPACE_CHANGES_CACHE_MAX_ENTRIES = 128;

interface WorkspaceChangesCacheEntry {
	stateKey: string;
	response: RuntimeWorkspaceChangesResponse;
	lastAccessedAt: number;
}

const workspaceChangesCacheByRepoRoot = new Map<string, WorkspaceChangesCacheEntry>();

interface NameStatusEntry {
	path: string;
	status: RuntimeWorkspaceFileStatus;
	previousPath?: string;
}

interface ChangesBetweenRefsInput {
	cwd: string;
	fromRef: string;
	toRef: string;
}

interface ChangesFromRefInput {
	cwd: string;
	fromRef: string;
}

interface DiffStat {
	additions: number;
	deletions: number;
}

function mapNameStatus(code: string): RuntimeWorkspaceFileStatus {
	const kind = code.charAt(0);
	if (kind === "M") return "modified";
	if (kind === "A") return "added";
	if (kind === "D") return "deleted";
	if (kind === "R") return "renamed";
	if (kind === "C") return "copied";
	if (kind === "U") return "conflicted";
	return "unknown";
}

function parseTrackedChanges(output: string): NameStatusEntry[] {
	const entries: NameStatusEntry[] = [];
	const lines = output
		.split("\n")
		.map((line) => line.trim())
		.filter(Boolean);

	for (const line of lines) {
		const parts = line.split("\t");
		const statusCode = parts[0];
		const status = mapNameStatus(statusCode);

		if ((status === "renamed" || status === "copied") && parts.length >= 3) {
			const previousPath = parts[1];
			const path = parts[2];
			if (path) {
				entries.push({
					path,
					previousPath: previousPath || undefined,
					status,
				});
			}
			continue;
		}

		const path = parts[1];
		if (path) {
			entries.push({
				path,
				status,
			});
		}
	}

	return entries;
}

function buildWorkspaceChangesStateKey(input: {
	repoRoot: string;
	headCommit: string | null;
	trackedChangesOutput: string;
	untrackedOutput: string;
	fingerprints: FileFingerprint[];
}): string {
	const fingerprintsToken = input.fingerprints
		.map((entry) => `${entry.path}\t${entry.size ?? "null"}\t${entry.mtimeMs ?? "null"}\t${entry.ctimeMs ?? "null"}`)
		.join("\n");
	return [
		input.repoRoot,
		input.headCommit ?? "no-head",
		input.trackedChangesOutput,
		input.untrackedOutput,
		fingerprintsToken,
	].join("\n--\n");
}

function pruneWorkspaceChangesCache(): void {
	if (workspaceChangesCacheByRepoRoot.size <= WORKSPACE_CHANGES_CACHE_MAX_ENTRIES) {
		return;
	}
	const entries = Array.from(workspaceChangesCacheByRepoRoot.entries()).sort(
		(left, right) => left[1].lastAccessedAt - right[1].lastAccessedAt,
	);
	const removeCount = entries.length - WORKSPACE_CHANGES_CACHE_MAX_ENTRIES;
	for (let index = 0; index < removeCount; index += 1) {
		const candidate = entries[index];
		if (!candidate) {
			break;
		}
		workspaceChangesCacheByRepoRoot.delete(candidate[0]);
	}
}

async function readHeadFile(repoRoot: string, path: string): Promise<string | null> {
	try {
		return await getGitStdout(["show", `HEAD:${path}`], repoRoot);
	} catch {
		return null;
	}
}

async function readFileAtRef(repoRoot: string, ref: string, path: string): Promise<string | null> {
	try {
		return await getGitStdout(["show", `${ref}:${path}`], repoRoot);
	} catch {
		return null;
	}
}

async function readWorkingTreeFile(repoRoot: string, path: string): Promise<string | null> {
	try {
		return await readFile(join(repoRoot, path), "utf8");
	} catch {
		return null;
	}
}

function fallbackStats(oldText: string | null, newText: string | null): DiffStat {
	if (oldText == null && newText == null) {
		return { additions: 0, deletions: 0 };
	}
	if (oldText == null) {
		return { additions: countLines(newText ?? ""), deletions: 0 };
	}
	if (newText == null) {
		return { additions: 0, deletions: countLines(oldText) };
	}

	const oldLines = countLines(oldText);
	const newLines = countLines(newText);
	return {
		additions: Math.max(newLines - oldLines, 0),
		deletions: Math.max(oldLines - newLines, 0),
	};
}

/**
 * Run a single `git diff --numstat` for all files at once and return a lookup map.
 * This replaces N individual per-file numstat calls with one batched command.
 * Numstat output format: `additions\tdeletions\tpath` (one line per file).
 * Binary files output `-\t-\tpath` which parses to { additions: 0, deletions: 0 }.
 */
async function batchDiffNumstat(repoRoot: string, args: string[]): Promise<Map<string, DiffStat>> {
	const result = new Map<string, DiffStat>();
	try {
		const output = await getGitStdout(["diff", "--numstat", ...args], repoRoot);
		for (const rawLine of output.split("\n")) {
			const line = rawLine.trim();
			if (!line) continue;
			const parts = line.split("\t");
			if (parts.length < 3) continue;
			const additions = Number.parseInt(parts[0] ?? "", 10);
			const deletions = Number.parseInt(parts[1] ?? "", 10);
			// The path is the last tab-separated field (handles rename output).
			const path = parts[parts.length - 1];
			if (path) {
				result.set(path, {
					additions: Number.isFinite(additions) ? additions : 0,
					deletions: Number.isFinite(deletions) ? deletions : 0,
				});
			}
		}
	} catch {
		// Fall through — callers use fallbackStats for missing entries.
	}
	return result;
}

async function buildFileChange(
	repoRoot: string,
	entry: NameStatusEntry,
	batchedStats: Map<string, DiffStat>,
): Promise<RuntimeWorkspaceFileChange> {
	const basePath = entry.previousPath ?? entry.path;
	const oldText =
		entry.status === "added" || entry.status === "untracked" ? null : await readHeadFile(repoRoot, basePath);
	const newText = entry.status === "deleted" ? null : await readWorkingTreeFile(repoRoot, entry.path);
	const stats =
		entry.status === "untracked"
			? { additions: countLines(newText ?? ""), deletions: 0 }
			: (batchedStats.get(entry.path) ?? fallbackStats(oldText, newText));

	return {
		path: entry.path,
		previousPath: entry.previousPath,
		status: entry.status,
		additions: stats.additions,
		deletions: stats.deletions,
		oldText,
		newText,
	};
}

async function buildFileChangeBetweenRefs(
	repoRoot: string,
	entry: NameStatusEntry,
	fromRef: string,
	toRef: string,
	batchedStats: Map<string, DiffStat>,
): Promise<RuntimeWorkspaceFileChange> {
	const basePath = entry.previousPath ?? entry.path;
	const oldText = entry.status === "added" ? null : await readFileAtRef(repoRoot, fromRef, basePath);
	const newText = entry.status === "deleted" ? null : await readFileAtRef(repoRoot, toRef, entry.path);
	const stats = batchedStats.get(entry.path) ?? fallbackStats(oldText, newText);

	return {
		path: entry.path,
		previousPath: entry.previousPath,
		status: entry.status,
		additions: stats.additions,
		deletions: stats.deletions,
		oldText,
		newText,
	};
}

async function buildFileChangeFromRef(
	repoRoot: string,
	entry: NameStatusEntry,
	fromRef: string,
	batchedStats: Map<string, DiffStat>,
): Promise<RuntimeWorkspaceFileChange> {
	const basePath = entry.previousPath ?? entry.path;
	const oldText =
		entry.status === "added" || entry.status === "untracked"
			? null
			: await readFileAtRef(repoRoot, fromRef, basePath);
	const newText = entry.status === "deleted" ? null : await readWorkingTreeFile(repoRoot, entry.path);
	const stats =
		entry.status === "untracked"
			? { additions: countLines(newText ?? ""), deletions: 0 }
			: (batchedStats.get(entry.path) ?? fallbackStats(oldText, newText));

	return {
		path: entry.path,
		previousPath: entry.previousPath,
		status: entry.status,
		additions: stats.additions,
		deletions: stats.deletions,
		oldText,
		newText,
	};
}

export async function createEmptyWorkspaceChangesResponse(cwd: string): Promise<RuntimeWorkspaceChangesResponse> {
	const repoRoot = await resolveRepoRoot(cwd);
	return {
		repoRoot,
		generatedAt: Date.now(),
		files: [],
	};
}

export async function getWorkspaceChanges(cwd: string): Promise<RuntimeWorkspaceChangesResponse> {
	const repoRoot = await resolveRepoRoot(cwd);

	const [trackedChangesOutput, untrackedOutput, headCommitOutput] = await Promise.all([
		getGitStdout(["diff", "--name-status", "HEAD", "--"], repoRoot),
		getGitStdout(["ls-files", "--others", "--exclude-standard"], repoRoot),
		getGitStdout(["rev-parse", "--verify", "HEAD"], repoRoot).catch(() => ""),
	]);
	const trackedChanges = parseTrackedChanges(trackedChangesOutput);
	const untrackedPaths = untrackedOutput
		.split("\n")
		.map((line) => line.trim())
		.filter(Boolean);

	const trackedPaths = new Set(trackedChanges.map((entry) => entry.path));
	const allChanges: NameStatusEntry[] = [
		...trackedChanges,
		...untrackedPaths
			.filter((path) => !trackedPaths.has(path))
			.map((path) => ({
				path,
				status: "untracked" as const,
			})),
	];
	const fingerprintPaths = allChanges.flatMap((entry) => [entry.path, entry.previousPath].filter(Boolean) as string[]);
	const fingerprints = await buildFileFingerprints(repoRoot, fingerprintPaths);
	const stateKey = buildWorkspaceChangesStateKey({
		repoRoot,
		headCommit: headCommitOutput.trim() || null,
		trackedChangesOutput,
		untrackedOutput,
		fingerprints,
	});
	const existing = workspaceChangesCacheByRepoRoot.get(repoRoot);
	if (existing && existing.stateKey === stateKey) {
		existing.lastAccessedAt = Date.now();
		return existing.response;
	}

	// Batch numstat for all tracked files in one git command instead of N per-file calls.
	const trackedEntries = allChanges.filter((entry) => entry.status !== "untracked");
	const numstatMap =
		trackedEntries.length > 0
			? await batchDiffNumstat(repoRoot, ["HEAD", "--", ...trackedEntries.map((e) => e.path)])
			: new Map<string, DiffStat>();

	const files = await Promise.all(allChanges.map((entry) => buildFileChange(repoRoot, entry, numstatMap)));
	files.sort((left, right) => left.path.localeCompare(right.path));
	const response: RuntimeWorkspaceChangesResponse = {
		repoRoot,
		generatedAt: Date.now(),
		files,
	};
	workspaceChangesCacheByRepoRoot.set(repoRoot, {
		stateKey,
		response,
		lastAccessedAt: Date.now(),
	});
	pruneWorkspaceChangesCache();
	return response;
}

export async function getWorkspaceChangesBetweenRefs(
	input: ChangesBetweenRefsInput,
): Promise<RuntimeWorkspaceChangesResponse> {
	const repoRoot = await resolveRepoRoot(input.cwd);

	const trackedChangesOutput = await getGitStdout(
		["diff", "--name-status", "--find-renames", input.fromRef, input.toRef, "--"],
		repoRoot,
	);
	const trackedChanges = parseTrackedChanges(trackedChangesOutput);
	if (trackedChanges.length === 0) {
		return {
			repoRoot,
			generatedAt: Date.now(),
			files: [],
		};
	}

	const numstatMap = await batchDiffNumstat(repoRoot, [
		input.fromRef,
		input.toRef,
		"--",
		...trackedChanges.map((e) => e.path),
	]);

	const files = await Promise.all(
		trackedChanges.map((entry) =>
			buildFileChangeBetweenRefs(repoRoot, entry, input.fromRef, input.toRef, numstatMap),
		),
	);
	files.sort((left, right) => left.path.localeCompare(right.path));

	return {
		repoRoot,
		generatedAt: Date.now(),
		files,
	};
}

export async function getWorkspaceChangesFromRef(input: ChangesFromRefInput): Promise<RuntimeWorkspaceChangesResponse> {
	const repoRoot = await resolveRepoRoot(input.cwd);

	const [trackedChangesOutput, untrackedOutput] = await Promise.all([
		getGitStdout(["diff", "--name-status", "--find-renames", input.fromRef, "--"], repoRoot),
		getGitStdout(["ls-files", "--others", "--exclude-standard"], repoRoot),
	]);
	const trackedChanges = parseTrackedChanges(trackedChangesOutput);
	const untrackedPaths = untrackedOutput
		.split("\n")
		.map((line) => line.trim())
		.filter(Boolean);
	const trackedPaths = new Set(trackedChanges.map((entry) => entry.path));
	const allChanges: NameStatusEntry[] = [
		...trackedChanges,
		...untrackedPaths
			.filter((path) => !trackedPaths.has(path))
			.map((path) => ({
				path,
				status: "untracked" as const,
			})),
	];

	if (allChanges.length === 0) {
		return {
			repoRoot,
			generatedAt: Date.now(),
			files: [],
		};
	}

	const trackedForNumstat = allChanges.filter((entry) => entry.status !== "untracked");
	const numstatMap =
		trackedForNumstat.length > 0
			? await batchDiffNumstat(repoRoot, [input.fromRef, "--", ...trackedForNumstat.map((e) => e.path)])
			: new Map<string, DiffStat>();

	const files = await Promise.all(
		allChanges.map((entry) => buildFileChangeFromRef(repoRoot, entry, input.fromRef, numstatMap)),
	);
	files.sort((left, right) => left.path.localeCompare(right.path));
	return {
		repoRoot,
		generatedAt: Date.now(),
		files,
	};
}
