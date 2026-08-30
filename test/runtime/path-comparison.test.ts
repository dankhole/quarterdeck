import { describe, expect, it } from "vitest";

import { areFileSystemPathsEqual, isFileSystemPathWithin } from "../../src/core";

describe("filesystem path comparison", () => {
	it("compares Windows paths case-insensitively after normalization", () => {
		expect(areFileSystemPathsEqual("C:\\Users\\Dev\\repo\\.", "c:\\users\\dev\\REPO", "win32")).toBe(true);
	});

	it("compares Windows namespace paths with their ordinary aliases", () => {
		expect(areFileSystemPathsEqual("\\\\?\\C:\\Users\\Dev\\repo", "c:\\users\\dev\\REPO", "win32")).toBe(true);
		expect(areFileSystemPathsEqual("\\\\?\\UNC\\Server\\Share\\repo", "\\\\server\\share\\REPO", "win32")).toBe(true);
	});

	it("accepts only the Windows root itself or separator-bounded descendants", () => {
		const root = "C:\\Users\\Dev\\.quarterdeck\\worktrees";
		expect(isFileSystemPathWithin(root, "c:\\users\\dev\\.quarterdeck\\worktrees", "win32")).toBe(true);
		expect(isFileSystemPathWithin(root, `${root}\\task-1\\repo`, "win32")).toBe(true);
		expect(isFileSystemPathWithin(root, `${root}-sibling\\repo`, "win32")).toBe(false);
		expect(isFileSystemPathWithin(root, "D:\\worktrees\\task-1", "win32")).toBe(false);
	});

	it("keeps POSIX path comparison case-sensitive", () => {
		expect(areFileSystemPathsEqual("/repo", "/REPO", "linux")).toBe(false);
		expect(isFileSystemPathWithin("/repo", "/repo/task", "linux")).toBe(true);
		expect(isFileSystemPathWithin("/repo", "/repository/task", "linux")).toBe(false);
	});
});
