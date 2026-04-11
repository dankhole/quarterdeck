import { promisify } from "node:util";

import { beforeEach, describe, expect, it, vi } from "vitest";

const childProcessMocks = vi.hoisted(() => ({
	execFile: vi.fn(),
	execFilePromise: vi.fn(),
}));

vi.mock("node:child_process", () => ({
	execFile: Object.assign(childProcessMocks.execFile, {
		[promisify.custom]: childProcessMocks.execFilePromise,
	}),
}));

vi.mock("node:fs/promises", () => ({
	stat: vi.fn().mockRejectedValue(new Error("ENOENT")),
	readFile: vi.fn().mockRejectedValue(new Error("ENOENT")),
}));

import { type GitWorkspaceProbe, getGitSyncSummary, probeGitWorkspaceState } from "../../src/workspace/git-sync";
import { getCommitsBehindBase } from "../../src/workspace/git-utils";

const FAKE_REPO = "/fake/repo";
const FAKE_COMMIT = "abc123def456789012345678901234567890abcd";
const FAKE_MERGE_BASE = "def456789012345678901234567890abcdef4567";

interface ExecCall {
	args: string[];
}

function capturedCalls(): ExecCall[] {
	return childProcessMocks.execFilePromise.mock.calls.map((call: unknown[]) => ({
		args: call[1] as string[],
	}));
}

function findCallContaining(...keywords: string[]): ExecCall {
	const match = capturedCalls().find((call) => keywords.every((kw) => call.args.includes(kw)));
	if (!match) {
		throw new Error(`No exec call found containing: ${keywords.join(", ")}`);
	}
	return match;
}

function assertFlagBeforeSubcommand(call: ExecCall, subcommand: string): void {
	const flagIndex = call.args.indexOf("--no-optional-locks");
	const subcommandIndex = call.args.indexOf(subcommand);
	expect(flagIndex).toBeGreaterThanOrEqual(0);
	expect(subcommandIndex).toBeGreaterThan(flagIndex);
}

function setupExecFileMock(statusOutput?: string): void {
	childProcessMocks.execFilePromise.mockImplementation((_cmd: string, args: string[]) => {
		if (args.includes("--show-toplevel")) {
			return Promise.resolve({ stdout: `${FAKE_REPO}\n`, stderr: "" });
		}
		if (args.includes("status")) {
			return Promise.resolve({
				stdout:
					statusOutput ??
					[
						`# branch.oid ${FAKE_COMMIT}`,
						"# branch.head main",
						"# branch.upstream origin/main",
						"# branch.ab +0 -0",
					].join("\n"),
				stderr: "",
			});
		}
		if (args.includes("--verify") && args.includes("HEAD")) {
			return Promise.resolve({ stdout: `${FAKE_COMMIT}\n`, stderr: "" });
		}
		if (args.includes("diff")) {
			return Promise.resolve({ stdout: "", stderr: "" });
		}
		return Promise.resolve({ stdout: "", stderr: "" });
	});
}

describe("git-sync --no-optional-locks", () => {
	beforeEach(() => {
		childProcessMocks.execFile.mockReset();
		childProcessMocks.execFilePromise.mockReset();
	});

	it("probeGitWorkspaceState passes --no-optional-locks to git status", async () => {
		setupExecFileMock();
		await probeGitWorkspaceState(FAKE_REPO);

		const statusCall = findCallContaining("status");
		assertFlagBeforeSubcommand(statusCall, "status");
	});

	it("probeGitWorkspaceState passes --no-optional-locks to git rev-parse HEAD", async () => {
		setupExecFileMock();
		await probeGitWorkspaceState(FAKE_REPO);

		const revParseCall = findCallContaining("rev-parse", "HEAD");
		assertFlagBeforeSubcommand(revParseCall, "rev-parse");
	});

	it("getGitSyncSummary passes --no-optional-locks to git diff", async () => {
		setupExecFileMock();

		const fakeProbe: GitWorkspaceProbe = {
			repoRoot: FAKE_REPO,
			headCommit: FAKE_COMMIT,
			currentBranch: "main",
			upstreamBranch: "origin/main",
			aheadCount: 0,
			behindCount: 0,
			changedFiles: 0,
			untrackedPaths: [],
			pathFingerprints: [],
			stateToken: "fake-token",
		};

		await getGitSyncSummary(FAKE_REPO, { probe: fakeProbe });

		const diffCall = findCallContaining("diff");
		assertFlagBeforeSubcommand(diffCall, "diff");
	});

	it("resolveRepoRoot passes --no-optional-locks to git rev-parse --show-toplevel", async () => {
		setupExecFileMock();
		await probeGitWorkspaceState(FAKE_REPO);

		const repoRootCall = findCallContaining("rev-parse", "--show-toplevel");
		assertFlagBeforeSubcommand(repoRootCall, "rev-parse");
	});

	it("getCommitsBehindBase passes --no-optional-locks to merge-base and rev-list", async () => {
		childProcessMocks.execFilePromise.mockImplementation((_cmd: string, args: string[]) => {
			if (args.includes("merge-base")) {
				return Promise.resolve({ stdout: `${FAKE_MERGE_BASE}\n`, stderr: "" });
			}
			if (args.includes("rev-list")) {
				return Promise.resolve({ stdout: "3\n", stderr: "" });
			}
			return Promise.resolve({ stdout: "", stderr: "" });
		});

		await getCommitsBehindBase(FAKE_REPO, "main");

		const mergeBaseCalls = capturedCalls().filter((c) => c.args.includes("merge-base"));
		expect(mergeBaseCalls.length).toBe(2);
		for (const call of mergeBaseCalls) {
			assertFlagBeforeSubcommand(call, "merge-base");
		}

		const revListCalls = capturedCalls().filter((c) => c.args.includes("rev-list"));
		expect(revListCalls.length).toBe(2);
		for (const call of revListCalls) {
			assertFlagBeforeSubcommand(call, "rev-list");
		}
	});

	it("probeGitWorkspaceState output is unchanged with --no-optional-locks", async () => {
		const statusOutput = [
			`# branch.oid ${FAKE_COMMIT}`,
			"# branch.head main",
			"# branch.upstream origin/main",
			"# branch.ab +2 -1",
			"1 .M N... 100644 100644 100644 abc123 def456 src/file.ts",
			"? untracked.txt",
		].join("\n");

		setupExecFileMock(statusOutput);
		const result = await probeGitWorkspaceState(FAKE_REPO);

		expect(result.currentBranch).toBe("main");
		expect(result.upstreamBranch).toBe("origin/main");
		expect(result.aheadCount).toBe(2);
		expect(result.behindCount).toBe(1);
		expect(result.changedFiles).toBe(2);
		expect(result.untrackedPaths).toContain("untracked.txt");
	});
});
