import { describe, expect, it } from "vitest";

import { arePathIdentitiesEqual, normalizePathIdentity } from "@/utils/path-identity";

describe("path identity", () => {
	it("normalizes and compares Windows drive paths case-insensitively", () => {
		expect(normalizePathIdentity("C:\\Repo\\Task\\")).toBe("C:/Repo/Task");
		expect(arePathIdentitiesEqual("C:\\Repo\\Task", "c:/repo/task/")).toBe(true);
	});

	it("normalizes extended-length Windows paths", () => {
		expect(normalizePathIdentity("\\\\?\\C:\\Repo\\Task\\")).toBe("C:/Repo/Task");
		expect(arePathIdentitiesEqual("\\\\?\\UNC\\Server\\Share\\Repo", "//server/share/repo/")).toBe(true);
	});

	it("compares UNC paths case-insensitively without changing POSIX semantics", () => {
		expect(arePathIdentitiesEqual("\\\\Server\\Share\\Repo", "//server/share/repo/")).toBe(true);
		expect(arePathIdentitiesEqual("/Repo/Task", "/repo/task")).toBe(false);
	});

	it("preserves valid POSIX path whitespace while rejecting whitespace-only input", () => {
		expect(normalizePathIdentity("/tmp/ project")).toBe("/tmp/ project");
		expect(normalizePathIdentity("/tmp/project ")).toBe("/tmp/project ");
		expect(arePathIdentitiesEqual("/tmp/project", "/tmp/project ")).toBe(false);
		expect(normalizePathIdentity(" \t ")).toBeNull();
	});
});
