import { describe, expect, it } from "vitest";
import { sanitizeGenerationResponse } from "../../../src/title";

describe("sanitizeGenerationResponse", () => {
	it("returns clean text unchanged", () => {
		expect(sanitizeGenerationResponse("Fix Auth Bug")).toBe("Fix Auth Bug");
	});

	it("strips outer double quotes", () => {
		expect(sanitizeGenerationResponse('"Fix Auth Bug"')).toBe("Fix Auth Bug");
	});

	it("strips outer single quotes", () => {
		expect(sanitizeGenerationResponse("'Fix Auth Bug'")).toBe("Fix Auth Bug");
	});

	it("strips known response prefixes", () => {
		expect(sanitizeGenerationResponse("Title: Fix Auth Bug")).toBe("Fix Auth Bug");
		expect(sanitizeGenerationResponse("Branch name: fix-auth-bug")).toBe("fix-auth-bug");
		expect(sanitizeGenerationResponse("Summary: Added auth middleware")).toBe("Added auth middleware");
		expect(sanitizeGenerationResponse("Commit message: improve commit generation")).toBe("improve commit generation");
	});

	it("strips conversational preambles", () => {
		expect(sanitizeGenerationResponse("Here's a title: Fix Auth Bug")).toBe("Fix Auth Bug");
		expect(sanitizeGenerationResponse("Here is the summary: Added auth middleware")).toBe("Added auth middleware");
		expect(sanitizeGenerationResponse("Sure, here's: Fix Auth Bug")).toBe("Fix Auth Bug");
		expect(sanitizeGenerationResponse("Certainly! Fix Auth Bug")).toBe("Fix Auth Bug");
	});

	it("strips trailing conversational noise", () => {
		expect(sanitizeGenerationResponse("Fix Auth Bug. Let me know if you'd like something different.")).toBe(
			"Fix Auth Bug.",
		);
		expect(sanitizeGenerationResponse("Fix Auth Bug. Would you like me to change it?")).toBe("Fix Auth Bug.");
	});

	it("rejects question and refusal responses", () => {
		expect(sanitizeGenerationResponse("What kind of title would you like?")).toBeNull();
		expect(sanitizeGenerationResponse("I can't generate a title without more context")).toBeNull();
		expect(sanitizeGenerationResponse("I need more information about the task")).toBeNull();
		expect(sanitizeGenerationResponse("Could you provide more details?")).toBeNull();
	});

	it("returns null for empty content", () => {
		expect(sanitizeGenerationResponse("")).toBeNull();
		expect(sanitizeGenerationResponse("   ")).toBeNull();
	});

	it("strips quotes exposed by prefix removal", () => {
		expect(sanitizeGenerationResponse('Title: "Fix Auth Bug"')).toBe("Fix Auth Bug");
	});
});
