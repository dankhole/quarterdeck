import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";

import type { RuntimeGitSyncSummary } from "../core";
import { resolveRepoRoot, runGit } from "./git-utils";

interface GitPathFingerprint {
	path: string;
	size: number | null;
	mtimeMs: number | null;
	ctimeMs: number | null;
}

export interface GitWorkdirProbe {
	repoRoot: string;
	headCommit: string | null;
	currentBranch: string | null;
	upstreamBranch: string | null;
	aheadCount: number;
	behindCount: number;
	changedFiles: number;
	untrackedPaths: string[];
	pathFingerprints: GitPathFingerprint[];
	stateToken: string;
}

function countLines(text: string): number {
	if (!text) {
		return 0;
	}
	return text.split("\n").length;
}

function parseNumstatTotals(output: string): { additions: number; deletions: number } {
	let additions = 0;
	let deletions = 0;

	for (const rawLine of output.split("\n")) {
		const line = rawLine.trim();
		if (!line) {
			continue;
		}
		const [addedRaw, deletedRaw] = line.split("\t");
		const added = Number.parseInt(addedRaw ?? "", 10);
		const deleted = Number.parseInt(deletedRaw ?? "", 10);
		if (Number.isFinite(added)) {
			additions += added;
		}
		if (Number.isFinite(deleted)) {
			deletions += deleted;
		}
	}

	return { additions, deletions };
}

function parseAheadBehindCounts(output: string): { aheadCount: number; behindCount: number } {
	const [aheadRaw, behindRaw] = output.trim().split(/\s+/, 2);
	const ahead = Math.abs(Number.parseInt(aheadRaw ?? "", 10));
	const behind = Math.abs(Number.parseInt(behindRaw ?? "", 10));
	return {
		aheadCount: Number.isFinite(ahead) ? ahead : 0,
		behindCount: Number.isFinite(behind) ? behind : 0,
	};
}

function buildFingerprintToken(fingerprints: GitPathFingerprint[]): string {
	return fingerprints
		.map((entry) => `${entry.path}\t${entry.size ?? "null"}\t${entry.mtimeMs ?? "null"}\t${entry.ctimeMs ?? "null"}`)
		.join("\n");
}

async function buildPathFingerprints(repoRoot: string, paths: string[]): Promise<GitPathFingerprint[]> {
	const uniqueSortedPaths = Array.from(new Set(paths)).sort((left, right) => left.localeCompare(right));
	return await Promise.all(
		uniqueSortedPaths.map(async (path) => {
			try {
				const fileStat = await stat(join(repoRoot, path));
				return {
					path,
					size: fileStat.size,
					mtimeMs: fileStat.mtimeMs,
					ctimeMs: fileStat.ctimeMs,
				} satisfies GitPathFingerprint;
			} catch {
				return {
					path,
					size: null,
					mtimeMs: null,
					ctimeMs: null,
				} satisfies GitPathFingerprint;
			}
		}),
	);
}

function parseStatusPath(line: string): string | null {
	const trimmed = line.trim();
	if (!trimmed) {
		return null;
	}
	const parts = trimmed.split("\t");
	const metadata = parts[0]?.trim() ?? "";
	const tokens = metadata.split(/\s+/);
	return tokens[tokens.length - 1] ?? null;
}

export async function probeGitWorkdirState(cwd: string): Promise<GitWorkdirProbe> {
	const repoRoot = await resolveRepoRoot(cwd);
	const [statusResult, headCommitResult] = await Promise.all([
		runGit(repoRoot, ["--no-optional-locks", "status", "--porcelain=v2", "--branch", "--untracked-files=all"]),
		runGit(repoRoot, ["--no-optional-locks", "rev-parse", "--verify", "HEAD"]),
	]);

	if (!statusResult.ok) {
		throw new Error(statusResult.error ?? "Git status command failed.");
	}

	let currentBranch: string | null = null;
	let upstreamBranch: string | null = null;
	let aheadCount = 0;
	let behindCount = 0;
	const fingerprintPaths: string[] = [];
	const untrackedPaths: string[] = [];
	let changedFiles = 0;

	for (const rawLine of statusResult.stdout.split("\n")) {
		const line = rawLine.trim();
		if (!line) {
			continue;
		}
		if (line.startsWith("# branch.head ")) {
			const branchName = line.slice("# branch.head ".length).trim();
			currentBranch = branchName && branchName !== "(detached)" ? branchName : null;
			continue;
		}
		if (line.startsWith("# branch.upstream ")) {
			upstreamBranch = line.slice("# branch.upstream ".length).trim() || null;
			continue;
		}
		if (line.startsWith("# branch.ab ")) {
			const counts = parseAheadBehindCounts(line.slice("# branch.ab ".length));
			aheadCount = counts.aheadCount;
			behindCount = counts.behindCount;
			continue;
		}
		if (line.startsWith("? ")) {
			const path = line.slice(2).trim();
			if (!path) {
				continue;
			}
			changedFiles += 1;
			untrackedPaths.push(path);
			fingerprintPaths.push(path);
			continue;
		}
		if (line.startsWith("1 ") || line.startsWith("2 ") || line.startsWith("u ")) {
			const path = parseStatusPath(line);
			if (!path) {
				continue;
			}
			changedFiles += 1;
			fingerprintPaths.push(path);
			const renameParts = line.split("\t");
			const previousPath = renameParts[1]?.trim();
			if (previousPath) {
				fingerprintPaths.push(previousPath);
			}
		}
	}

	// Fallback: when no upstream is configured, try to compute ahead/behind
	// against origin/<branch> so indicators still appear for untracked branches.
	if (upstreamBranch === null && currentBranch !== null && aheadCount === 0 && behindCount === 0) {
		const originRef = `origin/${currentBranch}`;
		const revListResult = await runGit(repoRoot, [
			"--no-optional-locks",
			"rev-list",
			"--left-right",
			"--count",
			`HEAD...${originRef}`,
		]);
		if (revListResult.ok && revListResult.stdout) {
			const fallback = parseAheadBehindCounts(revListResult.stdout);
			aheadCount = fallback.aheadCount;
			behindCount = fallback.behindCount;
		}
	}

	const headCommit = headCommitResult.ok && headCommitResult.stdout ? headCommitResult.stdout : null;
	const fingerprints = await buildPathFingerprints(repoRoot, fingerprintPaths);

	return {
		repoRoot,
		headCommit,
		currentBranch,
		upstreamBranch,
		aheadCount,
		behindCount,
		changedFiles,
		untrackedPaths,
		pathFingerprints: fingerprints,
		stateToken: [
			repoRoot,
			headCommit ?? "no-head",
			currentBranch ?? "detached",
			upstreamBranch ?? "no-upstream",
			String(aheadCount),
			String(behindCount),
			statusResult.stdout,
			buildFingerprintToken(fingerprints),
		].join("\n--\n"),
	};
}

const untrackedLineCountCache = new Map<string, { mtimeMs: number; lineCount: number }>();
const UNTRACKED_CACHE_MAX_SIZE = 2_000;

async function countUntrackedAdditions(
	repoRoot: string,
	untrackedPaths: string[],
	fingerprints: GitPathFingerprint[],
): Promise<number> {
	const fingerprintByPath = new Map(fingerprints.map((fp) => [fp.path, fp]));
	const counts = await Promise.all(
		untrackedPaths.map(async (relativePath) => {
			const absolutePath = join(repoRoot, relativePath);
			const fp = fingerprintByPath.get(relativePath);
			if (fp?.mtimeMs != null) {
				const cached = untrackedLineCountCache.get(absolutePath);
				if (cached && cached.mtimeMs === fp.mtimeMs) {
					return cached.lineCount;
				}
			}
			try {
				const contents = await readFile(absolutePath, "utf8");
				const lineCount = countLines(contents);
				if (fp?.mtimeMs != null) {
					if (untrackedLineCountCache.size >= UNTRACKED_CACHE_MAX_SIZE) {
						const firstKey = untrackedLineCountCache.keys().next().value;
						if (firstKey !== undefined) {
							untrackedLineCountCache.delete(firstKey);
						}
					}
					untrackedLineCountCache.set(absolutePath, { mtimeMs: fp.mtimeMs, lineCount });
				}
				return lineCount;
			} catch {
				return 0;
			}
		}),
	);
	return counts.reduce((total, value) => total + value, 0);
}

export async function getGitSyncSummary(
	cwd: string,
	options?: { probe?: GitWorkdirProbe },
): Promise<RuntimeGitSyncSummary> {
	const probe = options?.probe ?? (await probeGitWorkdirState(cwd));
	const diffResult = await runGit(probe.repoRoot, ["--no-optional-locks", "diff", "--numstat", "HEAD", "--"]);
	const trackedTotals = diffResult.ok ? parseNumstatTotals(diffResult.stdout) : { additions: 0, deletions: 0 };
	const untrackedAdditions = await countUntrackedAdditions(
		probe.repoRoot,
		probe.untrackedPaths,
		probe.pathFingerprints,
	);

	return {
		currentBranch: probe.currentBranch,
		upstreamBranch: probe.upstreamBranch,
		changedFiles: probe.changedFiles,
		additions: trackedTotals.additions + untrackedAdditions,
		deletions: trackedTotals.deletions,
		aheadCount: probe.aheadCount,
		behindCount: probe.behindCount,
	};
}
