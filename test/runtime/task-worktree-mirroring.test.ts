import { constants, lstatSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it, vi } from "vitest";

import { IgnoredPathMirrorError, mirrorIgnoredPath } from "../../src/workdir";
import { createTempDir } from "../utilities/temp-dir";

function createErrnoError(code: string): NodeJS.ErrnoException {
	const error = new Error(code) as NodeJS.ErrnoException;
	error.code = code;
	return error;
}

describe("mirrorIgnoredPath", () => {
	it("mirrors successfully when symlink succeeds", async () => {
		const createSymlink = vi.fn(async () => {});
		const copyFile = vi.fn(async () => {});
		await expect(
			mirrorIgnoredPath({
				sourcePath: "/source",
				targetPath: "/target",
				isDirectory: true,
				createSymlink,
				copyFile,
				platform: "win32",
			}),
		).resolves.toBe("mirrored");
		expect(createSymlink).toHaveBeenCalledWith("/source", "/target", "junction");
		expect(copyFile).not.toHaveBeenCalled();
	});

	it("copies a Windows ignored file when symlink creation is unavailable", async () => {
		const createSymlink = vi.fn(async () => {
			throw createErrnoError("EPERM");
		});
		const copyFile = vi.fn(async () => {});

		await expect(
			mirrorIgnoredPath({
				sourcePath: "/source",
				targetPath: "/target",
				isDirectory: false,
				createSymlink,
				copyFile,
				platform: "win32",
			}),
		).resolves.toBe("copied");
		expect(createSymlink).toHaveBeenCalledWith("/source", "/target", "file");
		expect(copyFile).toHaveBeenCalledWith("/source", "/target", constants.COPYFILE_EXCL);
	});

	it("creates a readable task-local copy that cannot write through to the source", async () => {
		const { path: rootPath, cleanup } = createTempDir("quarterdeck-ignored-file-copy-");
		try {
			const sourcePath = join(rootPath, "source.env");
			const targetPath = join(rootPath, "target.env");
			writeFileSync(sourcePath, "SOURCE=original\n", "utf8");

			await expect(
				mirrorIgnoredPath({
					sourcePath,
					targetPath,
					isDirectory: false,
					createSymlink: async () => {
						throw createErrnoError("EPERM");
					},
					platform: "win32",
				}),
			).resolves.toBe("copied");

			expect(lstatSync(targetPath).isFile()).toBe(true);
			expect(readFileSync(targetPath, "utf8")).toBe("SOURCE=original\n");
			writeFileSync(targetPath, "SOURCE=task\n", "utf8");
			expect(readFileSync(sourcePath, "utf8")).toBe("SOURCE=original\n");
		} finally {
			cleanup();
		}
	});

	it("surfaces an actionable typed error when the Windows file copy also fails", async () => {
		const createSymlink = vi.fn(async () => {
			throw createErrnoError("EPERM");
		});
		const copyFile = vi.fn(async () => {
			throw createErrnoError("EACCES");
		});

		const result = mirrorIgnoredPath({
			sourcePath: "/source/setup.env",
			targetPath: "/target/setup.env",
			isDirectory: false,
			createSymlink,
			copyFile,
			platform: "win32",
		});

		await expect(result).rejects.toMatchObject({
			name: "IgnoredPathMirrorError",
			code: "IGNORED_PATH_MIRROR_FAILED",
			pathKind: "file",
			sourcePath: "/source/setup.env",
			targetPath: "/target/setup.env",
		});
		await expect(result).rejects.toThrow("Check that the source is readable and the task worktree is writable");
	});

	it("surfaces an actionable typed error when a directory junction fails", async () => {
		const createSymlink = vi.fn(async () => {
			throw new Error("unexpected");
		});
		const copyFile = vi.fn(async () => {});

		const result = mirrorIgnoredPath({
			sourcePath: "/source/cache",
			targetPath: "/target/cache",
			isDirectory: true,
			createSymlink,
			copyFile,
			platform: "win32",
		});

		await expect(result).rejects.toBeInstanceOf(IgnoredPathMirrorError);
		await expect(result).rejects.toMatchObject({ pathKind: "directory" });
		expect(copyFile).not.toHaveBeenCalled();
	});

	it("does not copy files after a non-Windows symlink failure", async () => {
		const createSymlink = vi.fn(async () => {
			throw createErrnoError("EIO");
		});
		const copyFile = vi.fn(async () => {});

		await expect(
			mirrorIgnoredPath({
				sourcePath: "/source/setup.env",
				targetPath: "/target/setup.env",
				isDirectory: false,
				createSymlink,
				copyFile,
				platform: "linux",
			}),
		).rejects.toBeInstanceOf(IgnoredPathMirrorError);
		expect(copyFile).not.toHaveBeenCalled();
	});
});
