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
		expect(resolveProjectInputPath("~/projects/foo", cwd)).toBe("/Users/testuser/projects/foo");
	});

	it("resolves tilde-backslash prefix to home-relative path", () => {
		// On macOS/Linux, resolve() does not convert backslashes — they're valid filename chars.
		// The function strips the ~\ prefix and resolves the rest against homedir.
		const result = resolveProjectInputPath("~\\projects\\foo", cwd);
		expect(result).toMatch(/^\/Users\/testuser/);
		expect(result).toContain("projects");
	});

	it("resolves absolute path relative to cwd (no-op)", () => {
		expect(resolveProjectInputPath("/absolute/path", cwd)).toBe("/absolute/path");
	});

	it("resolves relative path against cwd", () => {
		expect(resolveProjectInputPath("relative/path", cwd)).toBe("/some/working/dir/relative/path");
	});

	it("resolves dot to cwd", () => {
		expect(resolveProjectInputPath(".", cwd)).toBe("/some/working/dir");
	});

	it("resolves parent traversal against cwd", () => {
		expect(resolveProjectInputPath("../sibling", cwd)).toBe("/some/working/sibling");
	});

	it("does not expand tilde in the middle of a path", () => {
		expect(resolveProjectInputPath("foo/~/bar", cwd)).toBe("/some/working/dir/foo/~/bar");
	});
});
