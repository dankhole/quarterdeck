import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { detectGitRepositoryInfo, invalidateGitRepositoryInfoCache } from "../../src/state/project-state-utils";
import { runGit } from "../../src/workdir/git-utils";

vi.mock("../../src/workdir/git-utils", async (importOriginal) => ({
	...(await importOriginal<typeof import("../../src/workdir/git-utils")>()),
	runGit: vi.fn(),
}));

type GitResult = Awaited<ReturnType<typeof runGit>>;

function ok(stdout: string): GitResult {
	return { ok: true, stdout, stderr: "", output: stdout, error: null, exitCode: 0, timedOut: false };
}

const timedOut: GitResult = {
	ok: false,
	stdout: "",
	stderr: "",
	output: "",
	error: "Git command timed out after 5000ms",
	exitCode: -1,
	timedOut: true,
	failureKind: "timed_out",
	errorCode: "ETIMEDOUT",
};

const notRepository: GitResult = {
	...timedOut,
	timedOut: false,
	failureKind: "command_failed",
	errorCode: null,
	exitCode: 128,
};

function respondAsRepository(overrides: { head?: GitResult; branches?: GitResult; originHead?: GitResult } = {}): void {
	vi.mocked(runGit).mockImplementation(async (_cwd, args) => {
		if (args.includes("--show-toplevel")) return ok("/synthetic/repo");
		if (args.includes("for-each-ref")) return overrides.branches ?? ok("feature\nmain");
		if (args.includes("refs/remotes/origin/HEAD")) return overrides.originHead ?? ok("origin/main");
		return overrides.head ?? ok("main");
	});
}

let now = 1_000_000;

beforeEach(() => {
	vi.spyOn(Date, "now").mockImplementation(() => now);
});

afterEach(() => {
	invalidateGitRepositoryInfoCache();
	vi.restoreAllMocks();
	vi.resetAllMocks();
});

const known = { currentBranch: "main", defaultBranch: "main", branches: ["feature", "main"] };
const degraded = { currentBranch: null, defaultBranch: null, branches: [] };
/** Past the indeterminate retry floor, so the next read runs Git again. */
const PAST_RETRY_FLOOR_MS = 6_000;

describe("detectGitRepositoryInfo", () => {
	it("admits all four project-load probes as foreground work with the short metadata timeout", async () => {
		respondAsRepository();
		await expect(detectGitRepositoryInfo("/synthetic/repo")).resolves.toEqual(known);

		expect(runGit).toHaveBeenCalledTimes(4);
		for (const [, , options] of vi.mocked(runGit).mock.calls) {
			// Foreground admission uses the limiter's bounded queue wait and reserved
			// slots; the execution timeout must remain metadata's 5s, not inspection's 30s.
			expect(options).toEqual({ timeoutClass: "metadata", priority: "foreground" });
		}
	});

	it("answers with the last known info when Git stops responding after the cache expires", async () => {
		respondAsRepository();
		await expect(detectGitRepositoryInfo("/synthetic/repo")).resolves.toEqual(known);
		now += 31_000;
		vi.mocked(runGit).mockResolvedValue(timedOut);
		await expect(detectGitRepositoryInfo("/synthetic/repo")).resolves.toEqual(known);
		// A branch listing that times out must not publish an empty branch list.
		respondAsRepository({ branches: timedOut });
		await expect(detectGitRepositoryInfo("/synthetic/repo")).resolves.toEqual(known);
	});

	it("serves last-known info for a partial answer without caching it", async () => {
		respondAsRepository();
		await detectGitRepositoryInfo("/synthetic/repo");
		now += 31_000;
		respondAsRepository({ head: timedOut, originHead: timedOut });
		await expect(detectGitRepositoryInfo("/synthetic/repo")).resolves.toEqual(known);
		// The partial answer was not cached: once the retry floor passes, the next read asks Git again.
		now += PAST_RETRY_FLOOR_MS;
		respondAsRepository({ head: ok("feature") });
		await expect(detectGitRepositoryInfo("/synthetic/repo")).resolves.toMatchObject({ currentBranch: "feature" });
	});

	it("retires last-known info on a definite non-repository", async () => {
		respondAsRepository();
		await detectGitRepositoryInfo("/synthetic/repo");
		now += 31_000;
		vi.mocked(runGit).mockResolvedValue(notRepository);
		await expect(detectGitRepositoryInfo("/synthetic/repo")).rejects.toThrow("No git repository detected");
		// A later timeout must not revive the branch list of a path that stopped being a repository.
		vi.mocked(runGit).mockResolvedValue(timedOut);
		await expect(detectGitRepositoryInfo("/synthetic/repo")).resolves.toEqual(degraded);
	});

	it.each(["root", "head", "branches", "originHead"] as const)(
		"falls back without caching an overlong %s queue wait on cold and warm loads",
		async (probe) => {
			const queueTimedOut: GitResult = {
				...timedOut,
				timedOut: false,
				failureKind: "queue_timed_out",
				errorCode: null,
			};
			const stallProbe = () => {
				if (probe === "root") vi.mocked(runGit).mockResolvedValue(queueTimedOut);
				else respondAsRepository({ [probe]: queueTimedOut });
			};

			stallProbe();
			await expect(detectGitRepositoryInfo("/synthetic/repo")).resolves.toEqual(degraded);
			now += PAST_RETRY_FLOOR_MS;
			respondAsRepository();
			await expect(detectGitRepositoryInfo("/synthetic/repo")).resolves.toEqual(known);

			now += 31_000;
			stallProbe();
			await expect(detectGitRepositoryInfo("/synthetic/repo")).resolves.toEqual(known);
			now += PAST_RETRY_FLOOR_MS;
			respondAsRepository({ head: ok("feature") });
			await expect(detectGitRepositoryInfo("/synthetic/repo")).resolves.toMatchObject({ currentBranch: "feature" });
		},
	);

	it("does not remember a load that an invalidation overtook", async () => {
		let release!: () => void;
		const gate = new Promise<void>((resolveGate) => {
			release = resolveGate;
		});
		vi.mocked(runGit).mockImplementation(async (_cwd, args) => {
			if (args.includes("--show-toplevel")) {
				await gate;
				return ok("/synthetic/repo");
			}
			return args.includes("for-each-ref") ? ok("main") : ok("main");
		});
		const load = detectGitRepositoryInfo("/synthetic/repo");
		invalidateGitRepositoryInfoCache("/synthetic/repo");
		release();
		await load;
		vi.mocked(runGit).mockResolvedValue(timedOut);
		// The overtaken load wrote no fallback, so a timeout has nothing to reuse.
		await expect(detectGitRepositoryInfo("/synthetic/repo")).resolves.toEqual(degraded);
	});
});
