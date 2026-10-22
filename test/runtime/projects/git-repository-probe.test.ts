import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { DiagnosticJournal, DiagnosticRecorder, readDiagnosticJournal } from "../../../src/diagnostics";
import { hasGitRepository, probeGitRepository } from "../../../src/projects/git-repository-probe";
import { observeProjectAvailability } from "../../../src/projects/project-availability";
import { runGit } from "../../../src/workdir/git-utils";

vi.mock("../../../src/workdir/git-utils", () => ({ runGit: vi.fn() }));

afterEach(() => vi.resetAllMocks());

describe("Git repository probe diagnostics", () => {
	it("retains typed failure and project correlation in the production journal without private command output", async () => {
		const directory = await mkdtemp(join(tmpdir(), "quarterdeck-git-probe-"));
		const journal = new DiagnosticJournal(join(directory, "journal"));
		const recorder = new DiagnosticRecorder({ runtimeInstanceId: "git-probe-test", journal });
		const privateSentinel = "private-command-sentinel";
		vi.mocked(runGit).mockResolvedValue({
			ok: false,
			stdout: privateSentinel,
			stderr: privateSentinel,
			output: privateSentinel,
			error: privateSentinel,
			exitCode: -1,
			timedOut: false,
			failureKind: "spawn_unavailable",
			errorCode: "ENOENT",
		});
		try {
			const availability = await observeProjectAvailability(
				{ repoPath: directory, projectId: "synthetic-project" },
				{
					hasPendingRelocation: async () => false,
					probeGitRepository: (path, projectId) =>
						probeGitRepository(path, {
							onFailure: (failure) =>
								recorder.recordEvent(
									"project.git_validation_failed",
									failure,
									{ projectId },
									{ level: "warn", essential: true },
								),
						}),
				},
			);
			expect(availability).toEqual({ status: "unavailable", reason: "not_git_repository" });
			await recorder.close();
			const retained = await readDiagnosticJournal(join(directory, "journal"));
			expect(retained.warnings).toEqual([]);
			expect(retained.records).toHaveLength(1);
			expect(retained.records[0]).toMatchObject({
				name: "project.git_validation_failed",
				context: { projectId: "synthetic-project" },
				payload: { failureKind: "spawn_unavailable", errorCode: "ENOENT", exitCode: -1 },
			});
			expect(JSON.stringify(retained.records)).not.toContain(privateSentinel);
			expect(JSON.stringify(retained.records)).not.toContain(directory);
		} finally {
			await recorder.close();
			await rm(directory, { recursive: true, force: true });
		}
	});

	it("reports an ancestor repository as root mismatch and keeps observer failures out of admission", async () => {
		const directory = await mkdtemp(join(tmpdir(), "quarterdeck-git-root-"));
		vi.mocked(runGit).mockResolvedValue({
			ok: true,
			stdout: tmpdir(),
			stderr: "",
			output: tmpdir(),
			error: null,
			exitCode: 0,
			timedOut: false,
		});
		const onFailure = vi.fn(() => {
			throw new Error("observer failure");
		});
		try {
			await expect(hasGitRepository(directory, { onFailure })).resolves.toBe(false);
			expect(onFailure).toHaveBeenCalledWith({
				failureKind: "root_mismatch",
				errorCode: null,
				exitCode: 0,
				terminatedBySignal: false,
			});
		} finally {
			await rm(directory, { recursive: true, force: true });
		}
	});

	it.each(["timed_out", "launch_blocked"] as const)(
		"classifies a %s probe as indeterminate, not a missing repository",
		async (failureKind) => {
			const directory = await mkdtemp(join(tmpdir(), "quarterdeck-git-indeterminate-"));
			vi.mocked(runGit).mockResolvedValue({
				ok: false,
				stdout: "",
				stderr: "",
				output: "",
				error: "synthetic failure",
				exitCode: -1,
				timedOut: failureKind === "timed_out",
				failureKind,
				errorCode: failureKind === "timed_out" ? "ETIMEDOUT" : null,
			});
			try {
				await expect(probeGitRepository(directory)).resolves.toBe("indeterminate");
				// The boolean wrapper used by launch/add-project/desktop-launcher callers
				// stays conservative: indeterminate must never read as "has a repo".
				await expect(hasGitRepository(directory)).resolves.toBe(false);
			} finally {
				await rm(directory, { recursive: true, force: true });
			}
		},
	);

	it.each(["command_failed", "spawn_unavailable", "permission_denied"] as const)(
		"classifies a %s probe as a definitive not_repository result",
		async (failureKind) => {
			const directory = await mkdtemp(join(tmpdir(), "quarterdeck-git-not-repo-"));
			vi.mocked(runGit).mockResolvedValue({
				ok: false,
				stdout: "",
				stderr: "",
				output: "",
				error: "synthetic failure",
				exitCode: 1,
				timedOut: false,
				failureKind,
				errorCode: null,
			});
			try {
				await expect(probeGitRepository(directory)).resolves.toBe("not_repository");
			} finally {
				await rm(directory, { recursive: true, force: true });
			}
		},
	);

	it.each(["EAGAIN", "EMFILE", "ENFILE", "ENOMEM"] as const)(
		"classifies a command_failed probe with resource-exhaustion errorCode %s as indeterminate",
		async (errorCode) => {
			// These spawn errors never produced Git's own exit status: `execFile`
			// rejected before Git ran at all, so this proves nothing about whether
			// the directory is a repository.
			const directory = await mkdtemp(join(tmpdir(), "quarterdeck-git-resource-exhaustion-"));
			vi.mocked(runGit).mockResolvedValue({
				ok: false,
				stdout: "",
				stderr: "",
				output: "",
				error: "synthetic spawn failure",
				exitCode: -1,
				timedOut: false,
				failureKind: "command_failed",
				errorCode,
			});
			try {
				await expect(probeGitRepository(directory)).resolves.toBe("indeterminate");
			} finally {
				await rm(directory, { recursive: true, force: true });
			}
		},
	);

	it("classifies a signal-killed probe as indeterminate", async () => {
		const directory = await mkdtemp(join(tmpdir(), "quarterdeck-git-signal-death-"));
		vi.mocked(runGit).mockResolvedValue({
			ok: false,
			stdout: "",
			stderr: "",
			output: "",
			error: "synthetic signal death",
			exitCode: -1,
			timedOut: false,
			failureKind: "command_failed",
			errorCode: null,
			terminatedBySignal: true,
		});
		try {
			await expect(probeGitRepository(directory)).resolves.toBe("indeterminate");
		} finally {
			await rm(directory, { recursive: true, force: true });
		}
	});

	it("classifies a command_failed probe with a real git exit status as a definitive not_repository result", async () => {
		// git itself exits 128 for "not a git repository": that is a genuine answer,
		// not a probe that failed to run.
		const directory = await mkdtemp(join(tmpdir(), "quarterdeck-git-real-exit-"));
		vi.mocked(runGit).mockResolvedValue({
			ok: false,
			stdout: "",
			stderr: "fatal: not a git repository",
			output: "fatal: not a git repository",
			error: "fatal: not a git repository",
			exitCode: 128,
			timedOut: false,
			failureKind: "command_failed",
			errorCode: null,
		});
		try {
			await expect(probeGitRepository(directory)).resolves.toBe("not_repository");
		} finally {
			await rm(directory, { recursive: true, force: true });
		}
	});

	it("classifies a successful probe as a repository", async () => {
		const directory = await mkdtemp(join(tmpdir(), "quarterdeck-git-repo-"));
		vi.mocked(runGit).mockResolvedValue({
			ok: true,
			stdout: directory,
			stderr: "",
			output: directory,
			error: null,
			exitCode: 0,
			timedOut: false,
		});
		try {
			await expect(probeGitRepository(directory)).resolves.toBe("repository");
			await expect(hasGitRepository(directory)).resolves.toBe(true);
		} finally {
			await rm(directory, { recursive: true, force: true });
		}
	});
});
