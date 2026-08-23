import { describe, expect, it } from "vitest";
import { parseRemovedProjectPathFromStreamError } from "./project-navigation";

// ---------------------------------------------------------------------------
// parseRemovedProjectPathFromStreamError
// ---------------------------------------------------------------------------

describe("parseRemovedProjectPathFromStreamError", () => {
	it("extracts removed project path", () => {
		expect(
			parseRemovedProjectPathFromStreamError("Project no longer exists on disk and was removed: /tmp/project"),
		).toBe("/tmp/project");
	});

	it("trims whitespace from extracted path", () => {
		expect(
			parseRemovedProjectPathFromStreamError("Project no longer exists on disk and was removed:  /tmp/project  "),
		).toBe("/tmp/project");
	});

	it("returns null when prefix is not present", () => {
		expect(parseRemovedProjectPathFromStreamError("Something else happened")).toBeNull();
	});

	it("returns null for null input", () => {
		expect(parseRemovedProjectPathFromStreamError(null)).toBeNull();
	});
});
