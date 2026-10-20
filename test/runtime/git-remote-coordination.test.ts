import type * as nodeChildProcess from "node:child_process";
import { mkdirSync, symlinkSync } from "node:fs";
import type * as nodeFsPromises from "node:fs/promises";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const processMocks = vi.hoisted(() => ({ execFile: vi.fn(), realExecFile: vi.fn() }));
const fsMocks = vi.hoisted(() => ({ realpath: vi.fn() }));

vi.mock("node:child_process", async (importOriginal) => {
	const actual = await importOriginal<typeof nodeChildProcess>();
	processMocks.realExecFile.mockImplementation(actual.execFile);
	return { ...actual, execFile: processMocks.execFile };
});

vi.mock("node:fs/promises", async (importOriginal) => {
	const actual = await importOriginal<typeof nodeFsPromises>();
	fsMocks.realpath.mockImplementation(actual.realpath);
	return { ...actual, realpath: fsMocks.realpath };
});

import { installRuntimeProcessLaunchAdmission } from "../../src/core/runtime-process-launch-admission";
import { ProjectMetadataRemoteFetchPolicy } from "../../src/server/project-metadata-remote-fetch";
import { runGitSyncAction } from "../../src/workdir/git-sync";
import { runGit } from "../../src/workdir/git-utils";
import { createGitTestEnv, runGit as fixtureGit, initGitRepository } from "../utilities/git-env";
import { createTempDir } from "../utilities/temp-dir";

interface RemoteProcess {
	args: string[];
	cwd: string;
	complete: (error?: nodeChildProcess.ExecFileException) => void;
}

describe("Git remote command coordination", () => {
	let fixture: ReturnType<typeof createTempDir>;
	let repo: string;
	let worktree: string;
	let alias: string;
	let otherRepo: string;
	let remoteProcesses: RemoteProcess[];
	let policy: ProjectMetadataRemoteFetchPolicy | null;

	beforeEach(() => {
		fixture = createTempDir("quarterdeck-git-remote-coordination-");
		repo = join(fixture.path, "repo");
		worktree = join(fixture.path, "worktree");
		alias = join(fixture.path, "repo-alias");
		otherRepo = join(fixture.path, "other-repo");
		mkdirSync(repo);
		mkdirSync(otherRepo);
		initGitRepository(repo);
		initGitRepository(otherRepo);
		fixtureGit(repo, ["commit", "--allow-empty", "-m", "initial"]);
		fixtureGit(repo, ["worktree", "add", "-b", "feature", worktree]);
		symlinkSync(repo, alias, process.platform === "win32" ? "junction" : "dir");
		remoteProcesses = [];
		policy = null;
		fsMocks.realpath.mockClear();
		processMocks.execFile
			.mockReset()
			.mockImplementation(
				(
					binary: string,
					args: string[],
					options: { cwd: string },
					callback: (error: nodeChildProcess.ExecFileException | null, stdout: string, stderr: string) => void,
				) => {
					if (args.some((arg) => arg === "fetch" || arg === "pull" || arg === "push")) {
						remoteProcesses.push({
							args,
							cwd: options.cwd,
							complete: (error) => callback(error ?? null, "", error ? "fatal: synthetic remote failure" : ""),
						});
						return { pid: 12_345, kill: vi.fn(() => true) };
					}
					return processMocks.realExecFile(binary, args, options, callback);
				},
			);
	});

	afterEach(async () => {
		vi.useRealTimers();
		policy?.stop();
		// Release held synthetic processes even when an assertion fails.
		for (let index = 0; index < remoteProcesses.length; index += 1) {
			remoteProcesses[index].complete();
			await new Promise<void>((resolve) => setImmediate(resolve));
		}
		await policy?.waitForIdle();
		await fixture.cleanupAsync();
	});

	async function waitForCanonicalizations(count: number): Promise<void> {
		await vi.waitFor(() => expect(fsMocks.realpath).toHaveBeenCalledTimes(count));
		await Promise.all(fsMocks.realpath.mock.results.map((result) => result.value));
		// Drain the identity continuations so a missing queue would have started
		// the next remote process before the non-overlap assertion.
		await new Promise<void>((resolve) => setImmediate(resolve));
	}

	it("serializes fetch, pull and push across linked worktrees and symlink aliases, while probes and other repositories proceed", async () => {
		const fetch = runGit(repo, ["fetch", "--all", "--prune"]);
		await vi.waitFor(() => expect(remoteProcesses).toHaveLength(1));
		const pull = runGit(worktree, ["pull", "--ff-only"]);
		await waitForCanonicalizations(2);
		const push = runGit(alias, ["push"]);
		await waitForCanonicalizations(3);
		expect(remoteProcesses).toHaveLength(1);

		const otherFetch = runGit(otherRepo, ["fetch"]);
		await vi.waitFor(() => expect(remoteProcesses).toHaveLength(2));
		expect(remoteProcesses[1].cwd).toBe(otherRepo);
		await expect(runGit(worktree, ["--no-optional-locks", "status", "--porcelain"])).resolves.toMatchObject({
			ok: true,
		});
		remoteProcesses[1].complete();
		await expect(otherFetch).resolves.toMatchObject({ ok: true });

		remoteProcesses[0].complete();
		await vi.waitFor(() => expect(remoteProcesses).toHaveLength(3));
		expect(remoteProcesses[2].args).toContain("pull");
		remoteProcesses[2].complete();
		await vi.waitFor(() => expect(remoteProcesses).toHaveLength(4));
		expect(remoteProcesses[3].args).toContain("push");
		remoteProcesses[3].complete();
		expect((await Promise.all([fetch, pull, push])).every((result) => result.ok)).toBe(true);
	});

	it("shares admission between the background metadata fetch and a manual pull action", async () => {
		const onFetchSucceeded = vi.fn(async () => undefined);
		policy = new ProjectMetadataRemoteFetchPolicy({
			getProjectPath: () => repo,
			limitRemoteFetch: async (fetch) => await fetch(),
			onFetchSucceeded,
		});
		policy.requestFetch();
		await vi.waitFor(() => expect(remoteProcesses).toHaveLength(1));

		const pull = runGitSyncAction({ cwd: worktree, action: "pull" });
		await waitForCanonicalizations(2);
		expect(remoteProcesses).toHaveLength(1);
		expect(remoteProcesses[0].args).toContain("fetch");
		remoteProcesses[0].complete();

		await vi.waitFor(() => expect(remoteProcesses).toHaveLength(2));
		expect(remoteProcesses[1].args).toContain("pull");
		remoteProcesses[1].complete();
		await expect(pull).resolves.toMatchObject({ ok: true, action: "pull" });
		await policy.waitForIdle();
		expect(onFetchSucceeded).toHaveBeenCalledOnce();
	});

	it("admits the next remote command after a failed command", async () => {
		const fetch = runGit(repo, ["fetch"]);
		await vi.waitFor(() => expect(remoteProcesses).toHaveLength(1));
		const pull = runGit(worktree, ["pull", "--ff-only"]);
		await waitForCanonicalizations(2);
		remoteProcesses[0].complete(Object.assign(new Error("synthetic failure"), { code: 128 }));
		await expect(fetch).resolves.toMatchObject({ ok: false, error: "fatal: synthetic remote failure" });

		await vi.waitFor(() => expect(remoteProcesses).toHaveLength(2));
		remoteProcesses[1].complete();
		await expect(pull).resolves.toMatchObject({ ok: true });
	});

	it("does not spend a queued command's timeout before its process starts", async () => {
		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
		const fetch = runGit(repo, ["fetch"]);
		await vi.waitFor(() => expect(remoteProcesses).toHaveLength(1));
		const pull = runGit(worktree, ["pull", "--ff-only"], { timeoutMs: 25 });
		await waitForCanonicalizations(2);
		await vi.advanceTimersByTimeAsync(250);
		expect(remoteProcesses).toHaveLength(1);
		remoteProcesses[0].complete();
		await vi.advanceTimersByTimeAsync(0);
		expect(remoteProcesses).toHaveLength(2);
		remoteProcesses[1].complete();
		await expect(pull).resolves.toMatchObject({ ok: true, timedOut: false });
		await fetch;
	});

	it("rechecks runtime launch admission after waiting for another remote command", async () => {
		let revoked = false;
		const disposeAdmission = installRuntimeProcessLaunchAdmission({
			beforeSpawn: () => {
				if (revoked) throw new Error("Synthetic runtime lease revoked.");
			},
		});
		try {
			const fetch = runGit(repo, ["fetch"]);
			await vi.waitFor(() => expect(remoteProcesses).toHaveLength(1));
			const pull = runGit(worktree, ["pull", "--ff-only"]);
			await waitForCanonicalizations(2);
			expect(remoteProcesses).toHaveLength(1);

			revoked = true;
			remoteProcesses[0].complete();
			await expect(fetch).resolves.toMatchObject({ ok: true });
			await expect(pull).resolves.toMatchObject({
				ok: false,
				failureKind: "launch_blocked",
				error: "Synthetic runtime lease revoked.",
			});
			expect(remoteProcesses).toHaveLength(1);
		} finally {
			disposeAdmission();
		}
	});

	it("uses global repository options for identity instead of the calling directory", async () => {
		const fetch = runGit(repo, ["fetch"]);
		await vi.waitFor(() => expect(remoteProcesses).toHaveLength(1));
		const push = runGit(otherRepo, ["-C", alias, "-c", "advice.detachedHead=false", "push"]);
		await waitForCanonicalizations(2);
		expect(remoteProcesses).toHaveLength(1);
		remoteProcesses[0].complete();
		await vi.waitFor(() => expect(remoteProcesses).toHaveLength(2));
		remoteProcesses[1].complete();
		await expect(push).resolves.toMatchObject({ ok: true });
		await fetch;
	});

	it("does not launch a remote command if Git cannot resolve repository identity", async () => {
		await expect(runGit(fixture.path, ["fetch"])).resolves.toMatchObject({ ok: false });
		expect(remoteProcesses).toHaveLength(0);
	});

	it("uses the remote process environment to resolve repository identity", async () => {
		const fetch = runGit(repo, ["fetch"]);
		await vi.waitFor(() => expect(remoteProcesses).toHaveLength(1));
		const push = runGit(otherRepo, ["push"], {
			env: createGitTestEnv({ GIT_DIR: join(repo, ".git"), GIT_WORK_TREE: repo }),
		});
		await waitForCanonicalizations(2);
		expect(remoteProcesses).toHaveLength(1);
		remoteProcesses[0].complete();
		await vi.waitFor(() => expect(remoteProcesses).toHaveLength(2));
		remoteProcesses[1].complete();
		await expect(push).resolves.toMatchObject({ ok: true });
		await fetch;
	});

	it("does not launch a remote command if canonicalizing its common directory fails", async () => {
		fsMocks.realpath.mockRejectedValueOnce(new Error("synthetic realpath failure"));
		await expect(runGit(repo, ["pull"])).resolves.toMatchObject({
			ok: false,
			error: "Git remote command not started: shared Git directory could not be resolved.",
		});
		expect(remoteProcesses).toHaveLength(0);
	});
});
