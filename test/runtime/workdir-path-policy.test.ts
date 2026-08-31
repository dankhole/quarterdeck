import { describe, expect, it } from "vitest";
import {
	getWorkdirFolderLabelForWorktreePath,
	normalizeTaskIdForWorktreePath,
} from "../../src/workdir/task-worktree-path";
import { getUniquePaths, shouldSkipSymlink } from "../../src/workdir/task-worktree-symlinks";
import {
	assertMutableWorkdirPath,
	normalizeWorkdirRelativePath,
	WINDOWS_WORKDIR_PATH_INVALID_MESSAGE,
} from "../../src/workdir/workdir-path-policy";

describe("Windows workdir path policy", () => {
	it("blocks skipped directory aliases regardless of case", () => {
		for (const path of [".GIT/config", "NODE_MODULES/pkg/index.js", ".SvN/wc.db"]) {
			expect(() => assertMutableWorkdirPath(path, "win32")).toThrow("Cannot modify skipped workdir paths.");
		}
	});

	it("rejects names that alias invalid, device, or alternate-stream paths on Windows", () => {
		for (const path of [
			".git./config",
			"folder /file",
			"CON",
			"aux.txt",
			"COM¹.log",
			"CONOUT$",
			"file:stream",
			"bad?.txt",
			"control\u0001.txt",
			`${"x".repeat(256)}.txt`,
		]) {
			expect(() => normalizeWorkdirRelativePath(path, "win32"), path).toThrow(WINDOWS_WORKDIR_PATH_INVALID_MESSAGE);
		}
	});

	it("classifies Windows traversal before applying filename rules", () => {
		expect(() => normalizeWorkdirRelativePath("../outside.txt", "win32")).toThrow(
			"Path resolves outside the worktree.",
		);
	});

	it("rejects Windows-unsafe explicit task ids", () => {
		for (const taskId of ["CON", "lpt1.txt", "task:name", "task.", "task "]) {
			expect(() => normalizeTaskIdForWorktreePath(taskId, "win32"), taskId).toThrow(
				"Invalid task id for worktree path.",
			);
		}
	});

	it("treats ignored-path roots and metadata blacklists case-insensitively on Windows", () => {
		expect(getUniquePaths(["Cache", "cache/child", "CACHE"], "win32")).toEqual(["Cache"]);
		expect(shouldSkipSymlink("nested/.GIT/config", "win32")).toBe(true);
		expect(shouldSkipSymlink("nested/THUMBS.DB", "win32")).toBe(true);
	});

	it("preserves leading spaces that Windows permits in path components", () => {
		expect(normalizeWorkdirRelativePath(" leading.txt", "win32")).toBe(" leading.txt");
		expect(getUniquePaths([" leading/cache", " leading/cache/child"], "win32")).toEqual([" leading/cache"]);
	});

	it("uses a safe fallback label for a repository at a Windows drive root", () => {
		expect(getWorkdirFolderLabelForWorktreePath("C:\\", "win32")).toBe("project");
	});

	it("preserves POSIX folder whitespace in generated worktree labels", () => {
		expect(getWorkdirFolderLabelForWorktreePath("/tmp/ project ", "linux")).toBe(" project ");
	});
});
