import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
	detectGitRepositoryInfo,
	getTaskWorktreesHomePath,
	invalidateGitRepositoryInfoCache,
	isUnderWorktreesHome,
} from "../../src/state/project-state-utils";
import { runGit } from "../../src/workdir/git-utils";
import { createTempDir } from "../utilities/temp-dir";

vi.mock("../../src/workdir/git-utils", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../../src/workdir/git-utils")>();
	return { ...actual, runGit: vi.fn() };
});

describe("isUnderWorktreesHome", () => {
	const originalPlatform = process.platform;
	const originalStateHome = process.env.QUARTERDECK_STATE_HOME;

	afterEach(() => {
		Object.defineProperty(process, "platform", { value: originalPlatform });
		if (originalStateHome === undefined) {
			delete process.env.QUARTERDECK_STATE_HOME;
		} else {
			process.env.QUARTERDECK_STATE_HOME = originalStateHome;
		}
	});

	it("matches the configured worktrees root and descendants only", () => {
		const { path: stateHome, cleanup } = createTempDir("quarterdeck-state-utils-");
		try {
			process.env.QUARTERDECK_STATE_HOME = stateHome;
			const worktreesHome = getTaskWorktreesHomePath();

			expect(isUnderWorktreesHome(worktreesHome)).toBe(true);
			expect(isUnderWorktreesHome(join(worktreesHome, "task-1", "repo"))).toBe(true);
			expect(isUnderWorktreesHome(`${worktreesHome}-sibling`)).toBe(false);
		} finally {
			cleanup();
		}
	});

	it("normalizes Windows separators and drive casing", () => {
		Object.defineProperty(process, "platform", { value: "win32" });
		process.env.QUARTERDECK_STATE_HOME = "C:\\Users\\Dev\\.quarterdeck";

		expect(isUnderWorktreesHome("c:\\users\\dev\\.quarterdeck\\worktrees\\task-1\\repo")).toBe(true);
		expect(isUnderWorktreesHome("c:\\users\\dev\\.quarterdeck\\worktrees-sibling\\repo")).toBe(false);
	});
});

type MockGitResult = Awaited<ReturnType<typeof runGit>>;

function ok(stdout: string): MockGitResult {
	return {
		ok: true,
		stdout,
		stderr: "",
		output: stdout,
		error: null,
		exitCode: 0,
		timedOut: false,
		terminatedBySignal: false,
	};
}

/** A command that never produced Git's own exit status: proves nothing, must never collapse to an empty/null value. */
function indeterminate(): MockGitResult {
	return {
		ok: false,
		stdout: "",
		stderr: "",
		output: "",
		error: "synthetic timeout",
		exitCode: -1,
		timedOut: true,
		terminatedBySignal: false,
		failureKind: "timed_out",
		errorCode: "ETIMEDOUT",
	};
}

/** A command that ran and gave Git's own definitive "no" answer (e.g. detached HEAD, no origin/HEAD, not a repository). */
function definitive(overrides: Partial<MockGitResult> = {}): MockGitResult {
	return {
		ok: false,
		stdout: "",
		stderr: "fatal: synthetic",
		output: "fatal: synthetic",
		error: "fatal: synthetic",
		exitCode: 1,
		timedOut: false,
		terminatedBySignal: false,
		failureKind: "command_failed",
		errorCode: null,
		...overrides,
	};
}

type GitCommandKind = "root" | "branch" | "branches" | "remoteHead";

function commandKind(args: string[]): GitCommandKind {
	if (args.includes("rev-parse")) return "root";
	if (args.includes("for-each-ref")) return "branches";
	if (args.includes("refs/remotes/origin/HEAD")) return "remoteHead";
	return "branch";
}

/** Wires the mocked `runGit` to answer each of the four `loadGitRepositoryInfo` commands independently; `root` resolves to `repoPath` itself so every call shares one cache key. */
function mockGitRepository(repoPath: string, overrides: Partial<Record<GitCommandKind, MockGitResult>> = {}): void {
	vi.mocked(runGit).mockImplementation(async (_cwd: string, args: string[]) => {
		const kind = commandKind(args);
		if (kind === "root") return overrides.root ?? ok(repoPath);
		if (kind === "branch") return overrides.branch ?? ok("main");
		if (kind === "branches") return overrides.branches ?? ok("main");
		return overrides.remoteHead ?? definitive({ exitCode: 1 });
	});
}

function createDeferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((settle) => {
		resolve = settle;
	});
	return { promise, resolve };
}

describe("detectGitRepositoryInfo", () => {
	beforeEach(() => {
		vi.mocked(runGit).mockReset();
	});

	afterEach(() => {
		invalidateGitRepositoryInfoCache();
		vi.useRealTimers();
	});

	it("caches a definitive success and serves it within the TTL without re-running git", async () => {
		const repoPath = "/synthetic/project-cache-hit";
		mockGitRepository(repoPath);

		const first = await detectGitRepositoryInfo(repoPath);
		expect(first).toEqual({ currentBranch: "main", defaultBranch: "main", branches: ["main"] });
		const callsAfterFirst = vi.mocked(runGit).mock.calls.length;

		const second = await detectGitRepositoryInfo(repoPath);
		expect(second).toEqual(first);
		expect(vi.mocked(runGit).mock.calls.length).toBe(callsAfterFirst);
	});

	it("throws nothing and returns the degraded empty info for a root timeout with no prior value", async () => {
		const repoPath = "/synthetic/project-root-timeout-first";
		mockGitRepository(repoPath, { root: indeterminate() });

		await expect(detectGitRepositoryInfo(repoPath)).resolves.toEqual({
			currentBranch: null,
			defaultBranch: null,
			branches: [],
		});
	});

	it("throws the definitive 'No git repository detected' error for a real root failure", async () => {
		const repoPath = "/synthetic/project-not-a-repo";
		mockGitRepository(repoPath, { root: definitive({ exitCode: 128, stderr: "fatal: not a git repository" }) });

		await expect(detectGitRepositoryInfo(repoPath)).rejects.toThrow(`No git repository detected at ${repoPath}`);
	});

	it("leaves detached HEAD, a missing origin/HEAD, and an empty branch list as definitive (unchanged) outcomes", async () => {
		const repoPath = "/synthetic/project-definitive-outcomes";
		mockGitRepository(repoPath, {
			branch: definitive({ exitCode: 1 }), // detached HEAD: `symbolic-ref HEAD` fails definitively
			branches: ok(""), // empty repository: no refs under refs/heads
			remoteHead: definitive({ exitCode: 1 }), // no `origin/HEAD` configured
		});

		await expect(detectGitRepositoryInfo(repoPath)).resolves.toEqual({
			currentBranch: null,
			defaultBranch: null,
			branches: [],
		});
	});

	it.each<GitCommandKind>(["root", "branch", "branches", "remoteHead"])(
		"falls back to the prior good value, not an empty/null one, when the %s command is indeterminate, and never caches the degraded result as fresh",
		async (indeterminateCommand) => {
			const repoPath = `/synthetic/project-indeterminate-${indeterminateCommand}`;
			mockGitRepository(repoPath);
			const goodInfo = await detectGitRepositoryInfo(repoPath);
			expect(goodInfo.branches).toEqual(["main"]);

			// Force a re-probe (simulates the TTL having expired) without touching the
			// last-known-good fallback: a per-path invalidate must not clear it.
			invalidateGitRepositoryInfoCache(repoPath);
			mockGitRepository(repoPath, { [indeterminateCommand]: indeterminate() });
			vi.useFakeTimers();
			vi.setSystemTime(0);

			const fallback = await detectGitRepositoryInfo(repoPath);
			expect(fallback).toEqual(goodInfo);
			const callsAfterFallback = vi.mocked(runGit).mock.calls.length;

			// Within the retry floor, serve the fallback again without re-running git.
			vi.setSystemTime(1_000);
			const stillFallback = await detectGitRepositoryInfo(repoPath);
			expect(stillFallback).toEqual(goodInfo);
			expect(vi.mocked(runGit).mock.calls.length).toBe(callsAfterFallback);

			// Past the retry floor, git runs again and picks up a genuinely different
			// value (not just the same LKG echoed back): proves this is a real reload,
			// not a wrongly-armed floor still serving the old fallback.
			vi.setSystemTime(10_000);
			mockGitRepository(repoPath, { branches: ok("main\nfeature") });
			const recovered = await detectGitRepositoryInfo(repoPath);
			expect(recovered).toEqual({ currentBranch: "main", defaultBranch: "main", branches: ["feature", "main"] });
			expect(recovered).not.toEqual(goodInfo);
			const callsAfterRecovery = vi.mocked(runGit).mock.calls.length;
			expect(callsAfterRecovery).toBeGreaterThan(callsAfterFallback);

			// And that recovered value is now cached fresh: the next call is a TTL hit.
			const cacheHit = await detectGitRepositoryInfo(repoPath);
			expect(cacheHit).toEqual(recovered);
			expect(vi.mocked(runGit).mock.calls.length).toBe(callsAfterRecovery);
		},
	);

	it.each(["terminatedBySignal", "EAGAIN", "EMFILE", "ENFILE", "ENOMEM"] as const)(
		"treats a command_failed root result with %s as indeterminate end-to-end, not a missing repository",
		async (reason) => {
			const repoPath = `/synthetic/project-signal-resource-${reason}`;
			mockGitRepository(repoPath);
			const goodInfo = await detectGitRepositoryInfo(repoPath);

			invalidateGitRepositoryInfoCache(repoPath);
			mockGitRepository(repoPath, {
				root:
					reason === "terminatedBySignal"
						? definitive({ terminatedBySignal: true })
						: definitive({ errorCode: reason }),
			});

			await expect(detectGitRepositoryInfo(repoPath)).resolves.toEqual(goodInfo);
		},
	);

	it("clears the last-known-good fallback on a global invalidation", async () => {
		const repoPath = "/synthetic/project-global-invalidate";
		mockGitRepository(repoPath);
		await detectGitRepositoryInfo(repoPath);

		invalidateGitRepositoryInfoCache();
		mockGitRepository(repoPath, { branches: indeterminate() });
		await expect(detectGitRepositoryInfo(repoPath)).resolves.toEqual({
			currentBranch: null,
			defaultBranch: null,
			branches: [],
		});
	});

	it("serves the same fallback to every caller deduped onto one in-flight indeterminate load", async () => {
		const repoPath = "/synthetic/project-dedupe-fallback";
		mockGitRepository(repoPath);
		const goodInfo = await detectGitRepositoryInfo(repoPath);

		invalidateGitRepositoryInfoCache(repoPath);
		const rootDeferred = createDeferred<MockGitResult>();
		vi.mocked(runGit).mockImplementation(async (_cwd: string, args: string[]) => {
			if (commandKind(args) === "root") return rootDeferred.promise;
			return ok("main");
		});

		const callsBeforeDedupe = vi.mocked(runGit).mock.calls.length;
		const callers = [
			detectGitRepositoryInfo(repoPath),
			detectGitRepositoryInfo(repoPath),
			detectGitRepositoryInfo(repoPath),
		];
		rootDeferred.resolve(indeterminate());
		const results = await Promise.all(callers);

		for (const result of results) expect(result).toEqual(goodInfo);
		// Only the one shared load ever reached git: the root command is the only
		// one that runs before an indeterminate root short-circuits the load.
		expect(vi.mocked(runGit).mock.calls.length).toBe(callsBeforeDedupe + 1);
	});

	it("does not let invalidating one project block another project's in-flight load from caching its result", async () => {
		const repoPathA = "/synthetic/project-a-isolation";
		const repoPathB = "/synthetic/project-b-isolation";
		mockGitRepository(repoPathA);
		await detectGitRepositoryInfo(repoPathA);

		const rootDeferredB = createDeferred<MockGitResult>();
		vi.mocked(runGit).mockImplementation(async (_cwd: string, args: string[]) => {
			const kind = commandKind(args);
			if (kind === "root") return rootDeferredB.promise;
			if (kind === "branch") return ok("main");
			if (kind === "branches") return ok("main");
			return definitive({ exitCode: 1 });
		});

		const bLoad = detectGitRepositoryInfo(repoPathB);
		// Invalidating A bumps only A's generation; it must not block B's
		// still-pending load from writing its own cache/LKG entries.
		invalidateGitRepositoryInfoCache(repoPathA);
		rootDeferredB.resolve(ok(repoPathB));
		const goodInfoB = await bLoad;
		expect(goodInfoB).toEqual({ currentBranch: "main", defaultBranch: "main", branches: ["main"] });

		const callsAfterB = vi.mocked(runGit).mock.calls.length;
		await expect(detectGitRepositoryInfo(repoPathB)).resolves.toEqual(goodInfoB);
		expect(vi.mocked(runGit).mock.calls.length).toBe(callsAfterB); // TTL cache hit: B's write landed.

		// A per-path invalidate of B specifically (not A) must still preserve B's
		// own last-known-good fallback.
		invalidateGitRepositoryInfoCache(repoPathB);
		mockGitRepository(repoPathB, { branches: indeterminate() });
		await expect(detectGitRepositoryInfo(repoPathB)).resolves.toEqual(goodInfoB);
	});

	it("does not let a stale pre-invalidation indeterminate load re-arm the retry floor", async () => {
		const repoPath = "/synthetic/project-stale-floor-arm";
		mockGitRepository(repoPath);
		const goodInfo = await detectGitRepositoryInfo(repoPath);

		invalidateGitRepositoryInfoCache(repoPath); // generation 1; LKG preserved
		const rootDeferred = createDeferred<MockGitResult>();
		vi.mocked(runGit).mockImplementation(async (_cwd: string, args: string[]) =>
			commandKind(args) === "root" ? rootDeferred.promise : ok("main"),
		);
		const load1 = detectGitRepositoryInfo(repoPath); // captures generation 1, hangs on root

		invalidateGitRepositoryInfoCache(repoPath); // generation 2, while load 1 is still pending
		rootDeferred.resolve(indeterminate());
		await load1; // resolves from LKG; must not arm the floor for the now-current generation 2

		mockGitRepository(repoPath, { branches: ok("feature") });
		const load2 = await detectGitRepositoryInfo(repoPath);
		// If the stale load had wrongly armed the floor, this would short-circuit
		// back to `goodInfo` (branches ["main"]) without calling runGit at all.
		expect(load2).toEqual({ currentBranch: "main", defaultBranch: "main", branches: ["main", "feature"] });
		expect(load2).not.toEqual(goodInfo);
	});

	it("does not let a slower, earlier-started load overwrite a newer last-known-good value", async () => {
		const repoPath = "/synthetic/project-write-ordering";
		const rootDeferred1 = createDeferred<MockGitResult>();
		vi.mocked(runGit).mockImplementation(async (_cwd: string, args: string[]) => {
			const kind = commandKind(args);
			if (kind === "root") return rootDeferred1.promise;
			if (kind === "branch") return ok("main");
			if (kind === "branches") return ok("stale-old"); // what load 1 will see once it resumes, below
			return definitive({ exitCode: 1 });
		});
		// Load 1 starts (sequence 0) and hangs on its root command.
		const load1 = detectGitRepositoryInfo(repoPath);

		// Invalidating while load 1 is still pending bumps the generation and
		// evicts the in-flight entry, letting a fresh load 2 start immediately
		// rather than dedupe onto load 1. Load 2 runs to completion first.
		invalidateGitRepositoryInfoCache(repoPath);
		mockGitRepository(repoPath, { branches: ok("feature") });
		const load2 = await detectGitRepositoryInfo(repoPath);
		expect(load2).toEqual({ currentBranch: "main", defaultBranch: "main", branches: ["main", "feature"] });

		// Re-arm the "stale-old" answer load 1 will see for its still-unmade
		// branch/branches/remoteHead calls, then let its root resolve. Load 1
		// (older generation, lower sequence) now finally resolves successfully,
		// after load 2 already wrote a different value — its result must be
		// discarded, not allowed to clobber load 2's newer last-known-good value.
		vi.mocked(runGit).mockImplementation(async (_cwd: string, args: string[]) => {
			const kind = commandKind(args);
			if (kind === "root") return rootDeferred1.promise;
			if (kind === "branch") return ok("main");
			if (kind === "branches") return ok("stale-old");
			return definitive({ exitCode: 1 });
		});
		rootDeferred1.resolve(ok(repoPath));
		const load1Result = await load1;
		expect(load1Result.branches).toContain("stale-old");
		expect(load1Result).not.toEqual(load2);

		invalidateGitRepositoryInfoCache(repoPath); // force past the TTL without touching LKG
		mockGitRepository(repoPath, { branches: indeterminate() });
		await expect(detectGitRepositoryInfo(repoPath)).resolves.toEqual(load2);
	});
});
