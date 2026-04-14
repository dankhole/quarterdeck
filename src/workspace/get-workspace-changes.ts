import { readFile } from "node:fs/promises";
import { join } from "node:path";

import type {
	RuntimeWorkspaceChangesResponse,
	RuntimeWorkspaceFileChange,
	RuntimeWorkspaceFileStatus,
} from "../core/api-contract";
import type { FileFingerprint } from "./file-fingerprint";
import { buildFileFingerprints } from "./file-fingerprint";
import { countLines, getGitStdout, parseNumstatPerFile, resolveRepoRoot } from "./git-utils";

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

const REF_CHANGES_CACHE_MAX_ENTRIES = 64;

interface RefChangesCacheEntry {
	response: RuntimeWorkspaceChangesResponse;
	lastAccessedAt: number;
}

const refChangesCacheByKey = new Map<string, RefChangesCacheEntry>();

function pruneRefChangesCache(): void {
	if (refChangesCacheByKey.size <= REF_CHANGES_CACHE_MAX_ENTRIES) {
		return;
	}
	const entries = Array.from(refChangesCacheByKey.entries()).sort(
		(left, right) => left[1].lastAccessedAt - right[1].lastAccessedAt,
	);
	const removeCount = entries.length - REF_CHANGES_CACHE_MAX_ENTRIES;
	for (let index = 0; index < removeCount; index += 1) {
		const candidate = entries[index];
		if (!candidate) {
			break;
		}
		refChangesCacheByKey.delete(candidate[0]);
	}
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

/** Run `git diff --numstat <args>` in batch and return per-file stats. */
async function batchReadNumstat(repoRoot: string, args: string[]): Promise<Map<string, DiffStat>> {
	try {
		const output = await getGitStdout(["diff", "--numstat", ...args], repoRoot);
		return parseNumstatPerFile(output);
	} catch {
		return new Map();
	}
}

/** Build a metadata-only file change entry (no oldText/newText). */
function buildFileMetadata(entry: NameStatusEntry, stats: DiffStat | undefined): RuntimeWorkspaceFileChange {
	return {
		path: entry.path,
		previousPath: entry.previousPath,
		status: entry.status,
		additions: stats?.additions ?? 0,
		deletions: stats?.deletions ?? 0,
		oldText: null,
		newText: null,
	};
}

/** Count lines in an untracked file (for additions stat). */
async function countUntrackedFileLines(repoRoot: string, path: string): Promise<number> {
	try {
		const content = await readFile(join(repoRoot, path), "utf8");
		return countLines(content);
	} catch {
		return 0;
	}
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

	const numstatMap = await batchReadNumstat(repoRoot, ["HEAD", "--"]);
	const untrackedLineCounts = await Promise.all(
		allChanges
			.filter((entry) => entry.status === "untracked")
			.map(async (entry) => ({ path: entry.path, lines: await countUntrackedFileLines(repoRoot, entry.path) })),
	);
	const untrackedStatsMap = new Map(untrackedLineCounts.map((u) => [u.path, { additions: u.lines, deletions: 0 }]));
	const files = allChanges.map((entry) =>
		buildFileMetadata(
			entry,
			entry.status === "untracked" ? untrackedStatsMap.get(entry.path) : numstatMap.get(entry.path),
		),
	);
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

	// Resolve refs to commit hashes so branch names that advance don't serve stale cache.
	const [fromHash, toHash] = await Promise.all([
		getGitStdout(["rev-parse", input.fromRef], repoRoot).catch(() => input.fromRef),
		getGitStdout(["rev-parse", input.toRef], repoRoot).catch(() => input.toRef),
	]);
	const cacheKey = `${repoRoot}::${fromHash}::${toHash}`;
	const cached = refChangesCacheByKey.get(cacheKey);
	if (cached) {
		cached.lastAccessedAt = Date.now();
		return cached.response;
	}

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

	const numstatMap = await batchReadNumstat(repoRoot, ["--find-renames", input.fromRef, input.toRef, "--"]);
	const files = trackedChanges.map((entry) => buildFileMetadata(entry, numstatMap.get(entry.path)));
	files.sort((left, right) => left.path.localeCompare(right.path));

	const response: RuntimeWorkspaceChangesResponse = {
		repoRoot,
		generatedAt: Date.now(),
		files,
	};
	refChangesCacheByKey.set(cacheKey, { response, lastAccessedAt: Date.now() });
	pruneRefChangesCache();
	return response;
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

	const numstatMap = await batchReadNumstat(repoRoot, ["--find-renames", input.fromRef, "--"]);
	const untrackedLineCounts = await Promise.all(
		allChanges
			.filter((entry) => entry.status === "untracked")
			.map(async (entry) => ({ path: entry.path, lines: await countUntrackedFileLines(repoRoot, entry.path) })),
	);
	const untrackedStatsMap = new Map(untrackedLineCounts.map((u) => [u.path, { additions: u.lines, deletions: 0 }]));
	const files = allChanges.map((entry) =>
		buildFileMetadata(
			entry,
			entry.status === "untracked" ? untrackedStatsMap.get(entry.path) : numstatMap.get(entry.path),
		),
	);
	files.sort((left, right) => left.path.localeCompare(right.path));
	return {
		repoRoot,
		generatedAt: Date.now(),
		files,
	};
}

// ---------------------------------------------------------------------------
// Single-file content loading (on-demand)
// ---------------------------------------------------------------------------

export interface WorkspaceFileDiffInput {
	cwd: string;
	path: string;
	previousPath?: string;
	status: RuntimeWorkspaceFileStatus;
	fromRef?: string;
	toRef?: string;
}

export async function getWorkspaceFileDiff(
	input: WorkspaceFileDiffInput,
): Promise<{ path: string; oldText: string | null; newText: string | null }> {
	const repoRoot = await resolveRepoRoot(input.cwd);
	const basePath = input.previousPath ?? input.path;
	const isNew = input.status === "added" || input.status === "untracked";
	const isDeleted = input.status === "deleted";

	let oldText: string | null = null;
	let newText: string | null = null;

	if (input.fromRef && input.toRef) {
		// Between two refs
		if (!isNew) oldText = await readFileAtRef(repoRoot, input.fromRef, basePath);
		if (!isDeleted) newText = await readFileAtRef(repoRoot, input.toRef, input.path);
	} else if (input.fromRef) {
		// Ref vs working tree
		if (!isNew) oldText = await readFileAtRef(repoRoot, input.fromRef, basePath);
		if (!isDeleted) newText = await readWorkingTreeFile(repoRoot, input.path);
	} else {
		// HEAD vs working tree (uncommitted)
		if (!isNew) oldText = await readHeadFile(repoRoot, basePath);
		if (!isDeleted) newText = await readWorkingTreeFile(repoRoot, input.path);
	}

	return { path: input.path, oldText, newText };
}
