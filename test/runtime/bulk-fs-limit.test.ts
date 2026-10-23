import { mkdirSync, writeFileSync } from "node:fs";
import type * as FsPromises from "node:fs/promises";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const fsCalls = vi.hoisted(() => ({ active: 0, peak: 0, readFileCalls: [] as string[] }));

vi.mock("node:fs/promises", async (importOriginal) => {
	const actual = await importOriginal<typeof FsPromises>();
	const tracked =
		<Args extends unknown[], Result>(call: (...args: Args) => Promise<Result>, onCall?: (...args: Args) => void) =>
		async (...args: Args): Promise<Result> => {
			onCall?.(...args);
			fsCalls.active += 1;
			fsCalls.peak = Math.max(fsCalls.peak, fsCalls.active);
			try {
				return await call(...args);
			} finally {
				fsCalls.active -= 1;
			}
		};
	return {
		...actual,
		stat: tracked(actual.stat),
		readFile: tracked(actual.readFile, (path) => fsCalls.readFileCalls.push(String(path))),
	};
});

import { BULK_FS_CONCURRENCY } from "../../src/fs/bulk-fs-limit";
import { getGitSyncSummary, getWorkdirChanges, probeGitWorkdirState } from "../../src/workdir";
import { commitAll, initGitRepository } from "../utilities/git-env";
import { useProcessTestBudget } from "../utilities/process-test-budget";
import { createTempDir } from "../utilities/temp-dir";

useProcessTestBudget();

let temp: ReturnType<typeof createTempDir>;

beforeEach(() => {
	temp = createTempDir("quarterdeck-bulk-fs-limit-");
	fsCalls.active = 0;
	fsCalls.peak = 0;
	fsCalls.readFileCalls = [];
});

afterEach(() => {
	temp.cleanup();
});

function writeUntrackedFiles(repoPath: string, count: number, linesPerFile = 3): void {
	for (let index = 0; index < count; index += 1) {
		const lines = Array.from({ length: linesPerFile }, (_, line) => `line-${index}-${line}`).join("\n");
		writeFileSync(join(repoPath, `untracked-${index}.txt`), lines, "utf8");
	}
}

describe("bulk fs limiter", () => {
	it("caps in-flight stat/readFile calls across git-probe and get-workdir-changes fan-out", async () => {
		const repoA = join(temp.path, "repo-a");
		const repoB = join(temp.path, "repo-b");
		mkdirSync(repoA, { recursive: true });
		mkdirSync(repoB, { recursive: true });
		initGitRepository(repoA);
		initGitRepository(repoB);
		writeFileSync(join(repoA, "tracked.txt"), "base\n", "utf8");
		writeFileSync(join(repoB, "tracked.txt"), "base\n", "utf8");
		commitAll(repoA, "init");
		commitAll(repoB, "init");
		writeUntrackedFiles(repoA, 30);
		writeUntrackedFiles(repoB, 30);

		// Drive both call paths concurrently: both go through the same
		// process-wide limiter, so the combined peak must still stay bounded.
		await Promise.all([getGitSyncSummary(repoA), getWorkdirChanges(repoB)]);

		expect(fsCalls.peak).toBeGreaterThan(0);
		expect(fsCalls.peak).toBeLessThanOrEqual(BULK_FS_CONCURRENCY);
	});

	it("skips line counting and reports 0 additions for untracked files at or above the size cap", async () => {
		const repoPath = join(temp.path, "repo");
		mkdirSync(repoPath, { recursive: true });
		initGitRepository(repoPath);
		writeFileSync(join(repoPath, "tracked.txt"), "base\n", "utf8");
		commitAll(repoPath, "init");

		const bigFileLines = Array.from({ length: 120_000 }, (_, line) => `line-${line}`).join("\n");
		writeFileSync(join(repoPath, "big.txt"), bigFileLines, "utf8");
		expect(Buffer.byteLength(bigFileLines, "utf8")).toBeGreaterThan(1024 * 1024);

		const changes = await getWorkdirChanges(repoPath);
		const bigFile = changes.files.find((file) => file.path === "big.txt");
		expect(bigFile).toMatchObject({ status: "untracked", additions: 0 });
		expect(fsCalls.readFileCalls.some((path) => path.includes("big.txt"))).toBe(false);

		const summary = await getGitSyncSummary(repoPath);
		// Only the small tracked-file edit contributes; the oversized untracked
		// file is skipped rather than read in full.
		expect(summary.additions).toBe(0);
	});

	it("skips untracked line counting entirely above the untracked file-count cap", async () => {
		const repoPath = join(temp.path, "repo");
		mkdirSync(repoPath, { recursive: true });
		initGitRepository(repoPath);
		writeFileSync(join(repoPath, "tracked.txt"), "base\n", "utf8");
		commitAll(repoPath, "init");

		const UNTRACKED_LINE_COUNT_FILE_CAP = 2_000;
		writeUntrackedFiles(repoPath, UNTRACKED_LINE_COUNT_FILE_CAP + 1, 1);

		const changes = await getWorkdirChanges(repoPath);
		const untrackedFiles = changes.files.filter((file) => file.status === "untracked");
		expect(untrackedFiles.length).toBe(UNTRACKED_LINE_COUNT_FILE_CAP + 1);
		expect(untrackedFiles.every((file) => file.additions === 0)).toBe(true);
		expect(fsCalls.readFileCalls.some((path) => path.includes("untracked-"))).toBe(false);

		const probe = await probeGitWorkdirState(repoPath);
		expect(probe.untrackedPaths.length).toBe(UNTRACKED_LINE_COUNT_FILE_CAP + 1);
		const summary = await getGitSyncSummary(repoPath, { probe });
		expect(summary.additions).toBe(0);
	});
});
