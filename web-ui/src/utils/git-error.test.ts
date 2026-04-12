import { describe, expect, it } from "vitest";
import { parseGitErrorForDisplay } from "./git-error";

describe("parseGitErrorForDisplay", () => {
	it("strips the runGit verbose prefix", () => {
		const error =
			"Failed to run Git Command: \n Command: \n git switch my-branch failed \n error: Your local changes would be overwritten";
		expect(parseGitErrorForDisplay(error)).toBe("error: Your local changes would be overwritten");
	});

	it("handles multi-line git stderr", () => {
		const error =
			"Failed to run Git Command: \n Command: \n git switch feature/foo failed \n error: Your local changes to the following files would be overwritten by checkout:\n\tfile.txt\nPlease commit your changes or stash them before you switch branches.\nAborting";
		const result = parseGitErrorForDisplay(error);
		expect(result).toMatch(/^error: Your local changes/);
		expect(result).toContain("Aborting");
		expect(result).not.toContain("Failed to run Git Command");
	});

	it("strips prefix from commit hook failures", () => {
		const error =
			"Failed to run Git Command: \n Command: \n git commit -m test -- file.ts failed \n Running biome check on staged files...\nfile.ts:10 lint/style/noNonNullAssertion";
		const result = parseGitErrorForDisplay(error);
		expect(result).toMatch(/^Running biome check/);
		expect(result).not.toContain("Failed to run Git Command");
	});

	it("returns plain errors unchanged", () => {
		expect(parseGitErrorForDisplay("Branch name cannot be empty.")).toBe("Branch name cannot be empty.");
	});

	it("returns fallback strings unchanged", () => {
		expect(parseGitErrorForDisplay("Failed to switch to main")).toBe("Failed to switch to main");
	});
});
