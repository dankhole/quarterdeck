import { resolve } from "node:path";

import { describe, expect, it, vi } from "vitest";
import { resolveProjectInputPath } from "../../src/projects/project-path";

vi.mock("node:os", () => ({
	homedir: () => "/Users/testuser",
}));

describe("resolveProjectInputPath", () => {
	const cwd = "/some/working/dir";

	it("resolves bare tilde to home directory", () => {
		expect(resolveProjectInputPath("~", cwd)).toBe("/Users/testuser");
	});

	it("resolves tilde-slash prefix to home-relative path", () => {
		expect(resolveProjectInputPath("~/projects/foo", cwd)).toBe(resolve("/Users/testuser", "projects/foo"));
	});

	it("resolves tilde-backslash prefix to home-relative path", () => {
		expect(resolveProjectInputPath("~\\projects\\foo", cwd)).toBe(resolve("/Users/testuser", "projects\\foo"));
	});

	it("resolves absolute path relative to cwd (no-op)", () => {
		expect(resolveProjectInputPath("/absolute/path", cwd)).toBe(resolve(cwd, "/absolute/path"));
	});

	it("resolves relative path against cwd", () => {
		expect(resolveProjectInputPath("relative/path", cwd)).toBe(resolve(cwd, "relative/path"));
	});

	it("resolves dot to cwd", () => {
		expect(resolveProjectInputPath(".", cwd)).toBe(resolve(cwd));
	});

	it("resolves parent traversal against cwd", () => {
		expect(resolveProjectInputPath("../sibling", cwd)).toBe(resolve(cwd, "../sibling"));
	});

	it("does not expand tilde in the middle of a path", () => {
		expect(resolveProjectInputPath("foo/~/bar", cwd)).toBe(resolve(cwd, "foo/~/bar"));
	});
});
