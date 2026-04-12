import { describe, expect, it } from "vitest";
import { formatPathForDisplay } from "./path-display";

describe("formatPathForDisplay", () => {
	it("replaces Unix /Users/<user> prefix with ~", () => {
		expect(formatPathForDisplay("/Users/alice/projects/foo")).toBe("~/projects/foo");
	});

	it("replaces Unix /home/<user> prefix with ~", () => {
		expect(formatPathForDisplay("/home/bob/code")).toBe("~/code");
	});

	it("returns bare ~ when path equals the home directory exactly", () => {
		expect(formatPathForDisplay("/Users/alice")).toBe("~");
	});

	it("returns bare ~ for /home/<user> exactly", () => {
		expect(formatPathForDisplay("/home/bob")).toBe("~");
	});

	it("normalizes backslashes to forward slashes", () => {
		expect(formatPathForDisplay("C:\\Users\\alice\\code")).toBe("~/code");
	});

	it("handles Windows-style C:/Users/<user> prefix", () => {
		expect(formatPathForDisplay("C:/Users/alice/projects")).toBe("~/projects");
	});

	it("returns path unchanged when no home prefix detected", () => {
		expect(formatPathForDisplay("/var/log/app.log")).toBe("/var/log/app.log");
	});

	it("returns path unchanged for root path", () => {
		expect(formatPathForDisplay("/")).toBe("/");
	});

	it("handles empty string", () => {
		expect(formatPathForDisplay("")).toBe("");
	});

	it("does not replace /Users in a non-home context", () => {
		expect(formatPathForDisplay("/var/Users/fake")).toBe("/var/Users/fake");
	});

	it("normalizes mixed separators", () => {
		expect(formatPathForDisplay("/Users/alice\\subdir/file.txt")).toBe("~/subdir/file.txt");
	});
});
