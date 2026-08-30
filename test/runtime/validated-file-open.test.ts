import { lstat, mkdir, open, realpath, rename, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
	openValidatedContainedRegularFile,
	validateOpenedContainedRegularFile,
} from "../../src/fs/validated-file-open";
import { createTempDir } from "../utilities/temp-dir";

describe("validated contained file opening", () => {
	it("returns an open handle for an unchanged regular file inside the canonical root", async () => {
		const temporary = createTempDir("quarterdeck-validated-file-");
		try {
			const rootPath = join(temporary.path, "allowed");
			const filePath = join(rootPath, "session.jsonl");
			await mkdir(rootPath);
			await writeFile(filePath, "{}\n", "utf8");

			const result = await openValidatedContainedRegularFile({
				canonicalRoot: await realpath(rootPath),
				canonicalPath: await realpath(filePath),
			});

			expect(result.status).toBe("opened");
			if (result.status === "opened") {
				await expect(result.fileHandle.readFile("utf8")).resolves.toBe("{}\n");
				await result.fileHandle.close();
			}
		} finally {
			temporary.cleanup();
		}
	});

	it("rejects a canonical parent that is replaced by an escaping directory link after open", async () => {
		const temporary = createTempDir("quarterdeck-validated-file-swap-");
		try {
			const rootPath = join(temporary.path, "allowed");
			const parentPath = join(rootPath, "project");
			const movedParentPath = join(rootPath, "project-original");
			const outsidePath = join(temporary.path, "outside");
			const filePath = join(parentPath, "session.jsonl");
			await Promise.all([mkdir(parentPath, { recursive: true }), mkdir(outsidePath)]);
			await Promise.all([
				writeFile(filePath, "inside\n", "utf8"),
				writeFile(join(outsidePath, "session.jsonl"), "outside\n", "utf8"),
			]);

			const canonicalRoot = await realpath(rootPath);
			const canonicalPath = await realpath(filePath);
			const pathStat = await lstat(canonicalPath);
			const fileHandle = await open(canonicalPath, "r");
			try {
				await rename(parentPath, movedParentPath);
				await symlink(outsidePath, parentPath, process.platform === "win32" ? "junction" : "dir");

				await expect(
					validateOpenedContainedRegularFile({ canonicalRoot, canonicalPath, pathStat, fileHandle }),
				).resolves.toEqual({ status: "invalid", reason: "path_changed" });
			} finally {
				await fileHandle.close();
			}
		} finally {
			temporary.cleanup();
		}
	});
});
