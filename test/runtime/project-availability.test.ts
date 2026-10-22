import { mkdir, rename, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";

import { readProjectDirectoryIdentity } from "../../src/fs/project-directory-identity";
import {
	observeProjectAvailability,
	observeProjectAvailabilityDetailed,
} from "../../src/projects/project-availability";
import { initGitRepository } from "../utilities/git-env";
import { createTempDir } from "../utilities/temp-dir";

describe("project availability", () => {
	it.skipIf(process.platform !== "darwin")(
		"accepts device drift only with matching saved Darwin creation-time evidence",
		async () => {
			const root = createTempDir("quarterdeck-availability-darwin-");
			try {
				const directoryIdentity = await readProjectDirectoryIdentity(root.path);
				expect(directoryIdentity.darwinBirthtimeNs).toBeDefined();
				const changedDevice = (BigInt(directoryIdentity.device) + 1n).toString();
				await expect(
					observeProjectAvailability({
						repoPath: root.path,
						folderOnly: true,
						directoryIdentity: { ...directoryIdentity, device: changedDevice },
					}),
				).resolves.toEqual({ status: "available" });
				await expect(
					observeProjectAvailability({
						repoPath: root.path,
						folderOnly: true,
						directoryIdentity: {
							...directoryIdentity,
							darwinBirthtimeNs: (BigInt(directoryIdentity.darwinBirthtimeNs ?? "0") + 1n).toString(),
						},
					}),
				).resolves.toEqual({ status: "unavailable", reason: "invalid_location" });
				await expect(
					observeProjectAvailability({
						repoPath: root.path,
						folderOnly: true,
						directoryIdentity: { device: changedDevice, inode: directoryIdentity.inode },
					}),
				).resolves.toEqual({ status: "unavailable", reason: "invalid_location" });
			} finally {
				root.cleanup();
			}
		},
	);

	it("classifies a renamed folder without probing Git and recognizes its original identity at the new location", async () => {
		const root = createTempDir("quarterdeck-availability-");
		try {
			const oldPath = join(root.path, "before");
			const newPath = join(root.path, "after");
			await mkdir(oldPath);
			const identity = await stat(oldPath, { bigint: true });
			const directoryIdentity = { device: identity.dev.toString(), inode: identity.ino.toString() };
			await rename(oldPath, newPath);
			const probeGitRepository = vi.fn(async () => "repository" as const);
			await expect(observeProjectAvailability({ repoPath: oldPath }, { probeGitRepository })).resolves.toEqual({
				status: "unavailable",
				reason: "missing",
			});
			expect(probeGitRepository).not.toHaveBeenCalled();
			await expect(
				observeProjectAvailability({ repoPath: newPath, directoryIdentity, folderOnly: true }),
			).resolves.toEqual({
				status: "available",
			});
			await mkdir(oldPath);
			await expect(
				observeProjectAvailability({ repoPath: oldPath, directoryIdentity, folderOnly: true }),
			).resolves.toEqual({
				status: "unavailable",
				reason: "invalid_location",
			});
		} finally {
			root.cleanup();
		}
	});

	it("distinguishes a file from an inaccessible directory", async () => {
		const root = createTempDir("quarterdeck-availability-file-");
		try {
			const path = join(root.path, "file");
			await writeFile(path, "synthetic");
			await expect(observeProjectAvailability({ repoPath: path })).resolves.toEqual({
				status: "unavailable",
				reason: "not_directory",
			});
			await expect(
				observeProjectAvailability(
					{ repoPath: root.path },
					{
						pathIsDirectory: async () => {
							throw new Error("permission denied");
						},
					},
				),
			).resolves.toEqual({ status: "unavailable", reason: "inaccessible" });
		} finally {
			root.cleanup();
		}
	});

	it("does not adopt an ancestor Git repository when the project has no Git directory", async () => {
		const root = createTempDir("quarterdeck-availability-git-");
		try {
			initGitRepository(root.path);
			const child = join(root.path, "child");
			await mkdir(child);
			// Inject a deterministic probe: the real `probeGitRepository` spawns
			// git and can legitimately report `indeterminate` under heavy load
			// (see 1df4c352), which this test must not depend on. The mock still
			// distinguishes the repository root from its non-repository child,
			// which is the actual invariant under test.
			const probeGitRepository = async (path: string) => (path === root.path ? "repository" : "not_repository");
			await expect(observeProjectAvailability({ repoPath: child }, { probeGitRepository })).resolves.toEqual({
				status: "unavailable",
				reason: "not_git_repository",
			});
			await expect(observeProjectAvailability({ repoPath: root.path }, { probeGitRepository })).resolves.toEqual({
				status: "available",
			});
		} finally {
			root.cleanup();
		}
	});

	it.each(["pending", "unreadable"])("blocks a %s relocation before filesystem probes", async (reason) => {
		const pathIsDirectory = vi.fn(async () => true);
		await expect(
			observeProjectAvailability(
				{ projectId: "project", repoPath: "/synthetic" },
				{
					pathIsDirectory,
					hasPendingRelocation: async () => {
						if (reason === "unreadable") throw new Error("invalid journal");
						return true;
					},
				},
			),
		).resolves.toEqual({ status: "unavailable", reason: "relocation_pending" });
		expect(pathIsDirectory).not.toHaveBeenCalled();
	});

	it.each(["EMFILE", "ENFILE", "EAGAIN", "EBUSY", "ENOMEM"])(
		"treats %s as indeterminate rather than inaccessible",
		async (code) => {
			const root = createTempDir("quarterdeck-availability-pressure-");
			const pressure = Object.assign(new Error(code), { code });
			try {
				await expect(
					observeProjectAvailabilityDetailed(
						{ repoPath: root.path },
						{
							pathIsDirectory: async () => {
								throw pressure;
							},
						},
					),
				).resolves.toEqual({ availability: { status: "available" }, indeterminate: "filesystem" });
				await expect(
					observeProjectAvailabilityDetailed(
						{ repoPath: root.path, projectId: "synthetic-project" },
						{
							hasPendingRelocation: async () => {
								throw pressure;
							},
						},
					),
				).resolves.toEqual({
					availability: { status: "unavailable", reason: "relocation_pending" },
					indeterminate: "filesystem",
				});
			} finally {
				root.cleanup();
			}
		},
	);

	it("reports an indeterminate Git probe as provisionally available, never as a missing repository", async () => {
		const root = createTempDir("quarterdeck-availability-indeterminate-");
		try {
			await expect(
				observeProjectAvailabilityDetailed(
					{ repoPath: root.path },
					{ probeGitRepository: async () => "indeterminate" },
				),
			).resolves.toEqual({ availability: { status: "available" }, indeterminate: "git" });
		} finally {
			root.cleanup();
		}
	});

	it("only reports a Git-stage indeterminate after directory, relocation, and identity checks pass", async () => {
		const probeGitRepository = vi.fn(async () => "indeterminate" as const);
		await expect(
			observeProjectAvailabilityDetailed(
				{ projectId: "project", repoPath: "/synthetic-missing" },
				{ pathIsDirectory: async () => false, probeGitRepository },
			),
		).resolves.toEqual({ availability: { status: "unavailable", reason: "missing" }, indeterminate: null });
		expect(probeGitRepository).not.toHaveBeenCalled();

		await expect(
			observeProjectAvailabilityDetailed(
				{ projectId: "project", repoPath: "/synthetic-pending" },
				{
					pathIsDirectory: async () => true,
					hasPendingRelocation: async () => true,
					probeGitRepository,
				},
			),
		).resolves.toEqual({
			availability: { status: "unavailable", reason: "relocation_pending" },
			indeterminate: null,
		});
		expect(probeGitRepository).not.toHaveBeenCalled();

		const root = createTempDir("quarterdeck-availability-indeterminate-order-");
		try {
			await expect(
				observeProjectAvailabilityDetailed({ projectId: "project", repoPath: root.path }, { probeGitRepository }),
			).resolves.toEqual({ availability: { status: "available" }, indeterminate: "git" });
			expect(probeGitRepository).toHaveBeenCalledTimes(1);
		} finally {
			root.cleanup();
		}
	});
});
