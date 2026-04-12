import { describe, expect, it } from "vitest";
import { sanitizeErrorForToast } from "./app-toaster";

describe("sanitizeErrorForToast", () => {
	it("passes short single-line messages through unchanged", () => {
		expect(sanitizeErrorForToast("Commit failed.")).toBe("Commit failed.");
	});

	it("extracts first non-empty line from multi-line message", () => {
		const message = "error: Your local changes would be overwritten\n\tfile.txt\nPlease commit or stash.";
		expect(sanitizeErrorForToast(message)).toBe("error: Your local changes would be overwritten");
	});

	it("truncates long first line with ellipsis", () => {
		const longLine = "a".repeat(200);
		const result = sanitizeErrorForToast(longLine);
		expect(result.length).toBe(150);
		expect(result.endsWith("\u2026")).toBe(true);
	});

	it("skips empty leading lines", () => {
		const message = "\n\n  \nerror: something went wrong\ndetails here";
		expect(sanitizeErrorForToast(message)).toBe("error: something went wrong");
	});

	it("returns original if all lines are empty", () => {
		const message = "\n\n  \n";
		expect(sanitizeErrorForToast(message)).toBe(message);
	});

	it("handles exactly-at-threshold messages without truncation", () => {
		const message = "a".repeat(150);
		expect(sanitizeErrorForToast(message)).toBe(message);
	});

	it("strips runGit prefix and returns the git stderr", () => {
		const message =
			"Failed to run Git Command: \n Command: \n git switch my-branch failed \n error: Your local changes would be overwritten";
		expect(sanitizeErrorForToast(message)).toBe("error: Your local changes would be overwritten");
	});

	it("strips runGit prefix then truncates long stderr to first line", () => {
		const message =
			"Failed to run Git Command: \n Command: \n git commit -m test -- file.ts failed \n Running biome check on staged files...\nfile.ts:10 lint/style/noNonNullAssertion\nfile.ts:20 lint/correctness/noUnusedImports";
		expect(sanitizeErrorForToast(message)).toBe("Running biome check on staged files...");
	});
});
