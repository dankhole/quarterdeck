import { readFile } from "node:fs/promises";
import { join } from "node:path";

import type { RuntimeWorkdirChangesResponse, RuntimeWorkdirFileChange, RuntimeWorkdirFileStatus } from "../core";
import type { FileFingerprint } from "./file-fingerprint";
import { buildFileFingerprints } from "./file-fingerprint";
import { countLines, GIT_INSPECTION_OPTIONS, getGitStdout, parseNumstatPerFile, resolveRepoRoot } from "./git-utils";

const WORKDIR_CHANGES_CACHE_MAX_ENTRIES = 128;

interface WorkdirChangesCacheEntry {
	stateKey: string;
	response: RuntimeWorkdirChangesResponse;
	lastAccessedAt: number;
}

const workdirChangesCacheByRepoRoot = new Map<string, WorkdirChangesCacheEntry>();

interface NameStatusEntry {
	path: string;
	status: RuntimeWorkdirFileStatus;
	previousPath?: string;
}

interface ChangesBetweenRefsInput {
	cwd: string;
	fromRef: string;
	toRef: string;
	threeDot?: boolean;
}

interface ChangesFromRefInput {
	cwd: string;
	fromRef: string;
	threeDot?: boolean;
}

interface DiffStat {
	additions: number;
	deletions: number;
}

const REF_CHANGES_CACHE_MAX_ENTRIES = 64;

interface RefChangesCacheEntry {
	response: RuntimeWorkdirChangesResponse;
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

function mapNameStatus(code: string): RuntimeWorkdirFileStatus {
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
		const statusCode = parts[0] as string;
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

function buildWorkdirChangesStateKey(input: {
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

function pruneWorkdirChangesCache(): void {
	if (workdirChangesCacheByRepoRoot.size <= WORKDIR_CHANGES_CACHE_MAX_ENTRIES) {
		return;
	}
	const entries = Array.from(workdirChangesCacheByRepoRoot.entries()).sort(
		(left, right) => left[1].lastAccessedAt - right[1].lastAccessedAt,
	);
	const removeCount = entries.length - WORKDIR_CHANGES_CACHE_MAX_ENTRIES;
	for (let index = 0; index < removeCount; index += 1) {
		const candidate = entries[index];
		if (!candidate) {
			break;
		}
		workdirChangesCacheByRepoRoot.delete(candidate[0]);
	}
}

async function readHeadFile(repoRoot: string, path: string): Promise<string | null> {
	try {
		return await getGitStdout(["show", `HEAD:${path}`], repoRoot, GIT_INSPECTION_OPTIONS);
	} catch {
		return null;
	}
}

async function readFileAtRef(repoRoot: string, ref: string, path: string): Promise<string | null> {
	try {
		return await getGitStdout(["show", `${ref}:${path}`], repoRoot, GIT_INSPECTION_OPTIONS);
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
		const output = await getGitStdout(["diff", "--numstat", ...args], repoRoot, GIT_INSPECTION_OPTIONS);
		return parseNumstatPerFile(output);
	} catch {
		return new Map();
	}
}

function buildContentRevision(baseRevision: string | null, fingerprint: FileFingerprint | undefined): string {
	return [
		baseRevision ?? "no-base",
		fingerprint?.path ?? "no-path",
		fingerprint?.size ?? "null",
		fingerprint?.mtimeMs ?? "null",
		fingerprint?.ctimeMs ?? "null",
	].join(":");
}

function buildFingerprintMap(fingerprints: FileFingerprint[]): Map<string, FileFingerprint> {
	return new Map(fingerprints.map((fingerprint) => [fingerprint.path, fingerprint]));
}

/** Build a metadata-only file change entry (no oldText/newText). */
function buildFileMetadata(
	entry: NameStatusEntry,
	stats: DiffStat | undefined,
	contentRevision?: string,
): RuntimeWorkdirFileChange {
	return {
		path: entry.path,
		previousPath: entry.previousPath,
		status: entry.status,
		additions: stats?.additions ?? 0,
		deletions: stats?.deletions ?? 0,
		oldText: null,
		newText: null,
		contentRevision,
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

export async function createEmptyWorkdirChangesResponse(cwd: string): Promise<RuntimeWorkdirChangesResponse> {
	const repoRoot = await resolveRepoRoot(cwd);
	return {
		repoRoot,
		generatedAt: Date.now(),
		files: [],
	};
}

export async function getWorkdirChanges(cwd: string): Promise<RuntimeWorkdirChangesResponse> {
	const repoRoot = await resolveRepoRoot(cwd);

	const [trackedChangesOutput, untrackedOutput, headCommitOutput] = await Promise.all([
		getGitStdout(["diff", "--name-status", "HEAD", "--"], repoRoot, GIT_INSPECTION_OPTIONS),
		getGitStdout(["ls-files", "--others", "--exclude-standard"], repoRoot, GIT_INSPECTION_OPTIONS),
		getGitStdout(["rev-parse", "--verify", "HEAD"], repoRoot, GIT_INSPECTION_OPTIONS).catch(() => ""),
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
	const stateKey = buildWorkdirChangesStateKey({
		repoRoot,
		headCommit: headCommitOutput.trim() || null,
		trackedChangesOutput,
		untrackedOutput,
		fingerprints,
	});
	const existing = workdirChangesCacheByRepoRoot.get(repoRoot);
	if (existing && existing.stateKey === stateKey) {
		existing.lastAccessedAt = Date.now();
		return existing.response;
	}

	const numstatMap = await batchReadNumstat(repoRoot, ["HEAD", "--"]);
	const fingerprintByPath = buildFingerprintMap(fingerprints);
	const headCommit = headCommitOutput.trim() || null;
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
			buildContentRevision(headCommit, fingerprintByPath.get(entry.path)),
		),
	);
	files.sort((left, right) => left.path.localeCompare(right.path));
	const response: RuntimeWorkdirChangesResponse = {
		repoRoot,
		generatedAt: Date.now(),
		files,
	};
	workdirChangesCacheByRepoRoot.set(repoRoot, {
		stateKey,
		response,
		lastAccessedAt: Date.now(),
	});
	pruneWorkdirChangesCache();
	return response;
}

export async function getWorkdirChangesForPaths(
	cwd: string,
	paths: string[],
	options: { countUntrackedLines?: boolean } = {},
): Promise<RuntimeWorkdirChangesResponse> {
	const repoRoot = await resolveRepoRoot(cwd);
	const selectedPaths = paths.filter(Boolean);
	if (selectedPaths.length === 0) {
		return {
			repoRoot,
			generatedAt: Date.now(),
			files: [],
		};
	}

	const [trackedChangesOutput, untrackedOutput, headCommitOutput] = await Promise.all([
		getGitStdout(["diff", "--name-status", "HEAD", "--", ...selectedPaths], repoRoot, GIT_INSPECTION_OPTIONS),
		getGitStdout(
			["ls-files", "--others", "--exclude-standard", "--", ...selectedPaths],
			repoRoot,
			GIT_INSPECTION_OPTIONS,
		),
		getGitStdout(["rev-parse", "--verify", "HEAD"], repoRoot, GIT_INSPECTION_OPTIONS).catch(() => ""),
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

	const fingerprintPaths = allChanges.flatMap((entry) => [entry.path, entry.previousPath].filter(Boolean) as string[]);
	const fingerprints = await buildFileFingerprints(repoRoot, fingerprintPaths);
	const numstatMap = await batchReadNumstat(repoRoot, ["HEAD", "--", ...selectedPaths]);
	const fingerprintByPath = buildFingerprintMap(fingerprints);
	const headCommit = headCommitOutput.trim() || null;
	const untrackedLineCounts =
		options.countUntrackedLines === false
			? []
			: await Promise.all(
					allChanges
						.filter((entry) => entry.status === "untracked")
						.map(async (entry) => ({
							path: entry.path,
							lines: await countUntrackedFileLines(repoRoot, entry.path),
						})),
				);
	const untrackedStatsMap = new Map(untrackedLineCounts.map((u) => [u.path, { additions: u.lines, deletions: 0 }]));
	const files = allChanges.map((entry) =>
		buildFileMetadata(
			entry,
			entry.status === "untracked" ? untrackedStatsMap.get(entry.path) : numstatMap.get(entry.path),
			buildContentRevision(headCommit, fingerprintByPath.get(entry.path)),
		),
	);
	files.sort((left, right) => left.path.localeCompare(right.path));
	return {
		repoRoot,
		generatedAt: Date.now(),
		files,
	};
}

export async function getWorkdirChangesBetweenRefs(
	input: ChangesBetweenRefsInput,
): Promise<RuntimeWorkdirChangesResponse> {
	const repoRoot = await resolveRepoRoot(input.cwd);
	const threeDot = input.threeDot ?? false;

	// Resolve refs to commit hashes so branch names that advance don't serve stale cache.
	const [fromHash, toHash] = await Promise.all([
		getGitStdout(["rev-parse", input.fromRef], repoRoot, GIT_INSPECTION_OPTIONS).catch(() => input.fromRef),
		getGitStdout(["rev-parse", input.toRef], repoRoot, GIT_INSPECTION_OPTIONS).catch(() => input.toRef),
	]);
	const cacheKey = `${repoRoot}::${fromHash}::${toHash}::${threeDot ? "3dot" : "2dot"}`;
	const cached = refChangesCacheByKey.get(cacheKey);
	if (cached) {
		cached.lastAccessedAt = Date.now();
		return cached.response;
	}

	// Three-dot: `git diff A...B` diffs merge-base(A,B) against B — only branch-introduced changes.
	const diffSpec = threeDot ? [`${input.fromRef}...${input.toRef}`] : [input.fromRef, input.toRef];

	const trackedChangesOutput = await getGitStdout(
		["diff", "--name-status", "--find-renames", ...diffSpec, "--"],
		repoRoot,
		GIT_INSPECTION_OPTIONS,
	);
	const trackedChanges = parseTrackedChanges(trackedChangesOutput);
	if (trackedChanges.length === 0) {
		return {
			repoRoot,
			generatedAt: Date.now(),
			files: [],
		};
	}

	const numstatMap = await batchReadNumstat(repoRoot, ["--find-renames", ...diffSpec, "--"]);
	const contentRevision = `${fromHash.trim()}..${toHash.trim()}:${threeDot ? "3dot" : "2dot"}`;
	const files = trackedChanges.map((entry) => buildFileMetadata(entry, numstatMap.get(entry.path), contentRevision));
	files.sort((left, right) => left.path.localeCompare(right.path));

	const response: RuntimeWorkdirChangesResponse = {
		repoRoot,
		generatedAt: Date.now(),
		files,
	};
	refChangesCacheByKey.set(cacheKey, { response, lastAccessedAt: Date.now() });
	pruneRefChangesCache();
	return response;
}

const FROM_REF_CHANGES_CACHE_MAX_ENTRIES = 32;

interface FromRefChangesCacheEntry {
	stateKey: string;
	response: RuntimeWorkdirChangesResponse;
	lastAccessedAt: number;
}

const fromRefChangesCacheByKey = new Map<string, FromRefChangesCacheEntry>();

function pruneFromRefChangesCache(): void {
	if (fromRefChangesCacheByKey.size <= FROM_REF_CHANGES_CACHE_MAX_ENTRIES) {
		return;
	}
	const entries = Array.from(fromRefChangesCacheByKey.entries()).sort(
		(left, right) => left[1].lastAccessedAt - right[1].lastAccessedAt,
	);
	const removeCount = entries.length - FROM_REF_CHANGES_CACHE_MAX_ENTRIES;
	for (let index = 0; index < removeCount; index += 1) {
		const candidate = entries[index];
		if (!candidate) {
			break;
		}
		fromRefChangesCacheByKey.delete(candidate[0]);
	}
}

export async function getWorkdirChangesFromRef(input: ChangesFromRefInput): Promise<RuntimeWorkdirChangesResponse> {
	const repoRoot = await resolveRepoRoot(input.cwd);
	const threeDot = input.threeDot ?? false;

	// For three-dot mode, compute merge-base(fromRef, HEAD) and use it as the effective fromRef.
	// This shows only changes introduced since divergence, excluding base-side advancement.
	let effectiveFromRef = input.fromRef;
	if (threeDot) {
		const mergeBase = await getGitStdout(
			["merge-base", input.fromRef, "HEAD"],
			repoRoot,
			GIT_INSPECTION_OPTIONS,
		).catch(() => null);
		if (mergeBase) effectiveFromRef = mergeBase.trim();
	}

	const [trackedChangesOutput, untrackedOutput, fromHash] = await Promise.all([
		getGitStdout(
			["diff", "--name-status", "--find-renames", effectiveFromRef, "--"],
			repoRoot,
			GIT_INSPECTION_OPTIONS,
		),
		getGitStdout(["ls-files", "--others", "--exclude-standard"], repoRoot, GIT_INSPECTION_OPTIONS),
		getGitStdout(["rev-parse", effectiveFromRef], repoRoot, GIT_INSPECTION_OPTIONS).catch(() => effectiveFromRef),
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

	// Build fingerprints for cache validation — detects file content changes between polls.
	const fingerprintPaths = allChanges.flatMap((entry) => [entry.path, entry.previousPath].filter(Boolean) as string[]);
	const fingerprints = await buildFileFingerprints(repoRoot, fingerprintPaths);
	const resolvedFromHash = fromHash.trim();
	const cacheMapKey = `${repoRoot}::${resolvedFromHash}::${threeDot ? "3dot" : "2dot"}`;
	const stateKey = buildWorkdirChangesStateKey({
		repoRoot,
		headCommit: resolvedFromHash,
		trackedChangesOutput,
		untrackedOutput,
		fingerprints,
	});
	const existing = fromRefChangesCacheByKey.get(cacheMapKey);
	if (existing && existing.stateKey === stateKey) {
		existing.lastAccessedAt = Date.now();
		return existing.response;
	}

	const numstatMap = await batchReadNumstat(repoRoot, ["--find-renames", effectiveFromRef, "--"]);
	const fingerprintByPath = buildFingerprintMap(fingerprints);
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
			buildContentRevision(resolvedFromHash, fingerprintByPath.get(entry.path)),
		),
	);
	files.sort((left, right) => left.path.localeCompare(right.path));
	const response: RuntimeWorkdirChangesResponse = {
		repoRoot,
		generatedAt: Date.now(),
		files,
	};
	fromRefChangesCacheByKey.set(cacheMapKey, { stateKey, response, lastAccessedAt: Date.now() });
	pruneFromRefChangesCache();
	return response;
}

// ---------------------------------------------------------------------------
// Single-file content loading (on-demand)
// ---------------------------------------------------------------------------

export interface WorkdirFileDiffInput {
	cwd: string;
	path: string;
	previousPath?: string;
	status: RuntimeWorkdirFileStatus;
	fromRef?: string;
	toRef?: string;
	threeDot?: boolean;
}

export async function getWorkdirFileDiff(
	input: WorkdirFileDiffInput,
): Promise<{ path: string; oldText: string | null; newText: string | null }> {
	const repoRoot = await resolveRepoRoot(input.cwd);
	const basePath = input.previousPath ?? input.path;
	const isNew = input.status === "added" || input.status === "untracked";
	const isDeleted = input.status === "deleted";

	// In three-dot mode, read old content from the merge-base instead of fromRef directly.
	// This ensures the "before" side matches the divergence point, not the current base tip.
	let effectiveFromRef = input.fromRef;
	if (input.threeDot && input.fromRef) {
		const targetRef = input.toRef ?? "HEAD";
		const mergeBase = await getGitStdout(
			["merge-base", input.fromRef, targetRef],
			repoRoot,
			GIT_INSPECTION_OPTIONS,
		).catch(() => null);
		if (mergeBase) effectiveFromRef = mergeBase.trim();
	}

	let oldTextPromise = Promise.resolve<string | null>(null);
	let newTextPromise = Promise.resolve<string | null>(null);

	if (effectiveFromRef && input.toRef) {
		// Between two refs
		if (!isNew) oldTextPromise = readFileAtRef(repoRoot, effectiveFromRef, basePath);
		if (!isDeleted) newTextPromise = readFileAtRef(repoRoot, input.toRef, input.path);
	} else if (effectiveFromRef) {
		// Ref vs working tree
		if (!isNew) oldTextPromise = readFileAtRef(repoRoot, effectiveFromRef, basePath);
		if (!isDeleted) newTextPromise = readWorkingTreeFile(repoRoot, input.path);
	} else {
		// HEAD vs working tree (uncommitted)
		if (!isNew) oldTextPromise = readHeadFile(repoRoot, basePath);
		if (!isDeleted) newTextPromise = readWorkingTreeFile(repoRoot, input.path);
	}

	const [oldText, newText] = await Promise.all([oldTextPromise, newTextPromise]);

	return { path: input.path, oldText, newText };
}
