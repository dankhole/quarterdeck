import { mkdir, rename, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";

import { observeProjectAvailability } from "../../src/projects/project-availability";
import { initGitRepository } from "../utilities/git-env";
import { createTempDir } from "../utilities/temp-dir";

describe("project availability", () => {
	it("classifies a renamed folder without probing Git and recognizes its original identity at the new location", async () => {
		const root = createTempDir("quarterdeck-availability-");
		try {
			const oldPath = join(root.path, "before");
			const newPath = join(root.path, "after");
			await mkdir(oldPath);
			const identity = await stat(oldPath, { bigint: true });
			const directoryIdentity = { device: identity.dev.toString(), inode: identity.ino.toString() };
			await rename(oldPath, newPath);
			const hasGitRepository = vi.fn(async () => true);
			await expect(observeProjectAvailability({ repoPath: oldPath }, { hasGitRepository })).resolves.toEqual({
				status: "unavailable",
				reason: "missing",
			});
			expect(hasGitRepository).not.toHaveBeenCalled();
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
			await expect(observeProjectAvailability({ repoPath: child })).resolves.toEqual({
				status: "unavailable",
				reason: "not_git_repository",
			});
			await expect(observeProjectAvailability({ repoPath: root.path })).resolves.toEqual({ status: "available" });
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
});
