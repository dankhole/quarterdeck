import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { DiagnosticJournal, DiagnosticRecorder, readDiagnosticJournal } from "../../../src/diagnostics";
import { hasGitRepository } from "../../../src/projects/git-repository-probe";
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
					hasGitRepository: (path, projectId) =>
						hasGitRepository(path, {
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
			expect(onFailure).toHaveBeenCalledWith({ failureKind: "root_mismatch", errorCode: null, exitCode: 0 });
		} finally {
			await rm(directory, { recursive: true, force: true });
		}
	});
});
