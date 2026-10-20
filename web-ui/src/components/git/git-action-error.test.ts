// @vitest-environment node
import { describe, expect, it } from "vitest";
import { getGitActionErrorPresentation } from "./git-action-error";

describe("Git action error presentation", () => {
	it("finds the fatal reason after fetch progress and deduplicates legacy stderr", () => {
		const stderr = [
			"remote: Enumerating objects: 428, done.",
			"Receiving objects: 100% (428/428), done.",
			"From /synthetic/origin",
			" * [new branch]      feature -> origin/feature",
			"fatal: unable to update local ref",
		].join("\n");
		const output = `Fetched remote objects\n${stderr}`;
		expect(getGitActionErrorPresentation(stderr, output)).toEqual({
			summary: "fatal: unable to update local ref",
			details: output,
		});
	});

	it("preserves useful multiline error context and the unabridged details", () => {
		const message = [
			"error: Your local changes to the following files would be overwritten by merge:",
			"\tsrc/example.ts",
			"Please commit your changes or stash them before you merge.",
			"Aborting",
		].join("\n");
		const result = getGitActionErrorPresentation(message, null);
		expect(result.summary).toBe(
			"error: Your local changes to the following files would be overwritten by merge:\nsrc/example.ts\nPlease commit your changes or stash them before you merge.",
		);
		expect(result.details).toBe(message);
	});

	it("keeps explicit timeout errors ahead of partial command output", () => {
		const message = "Git command timed out after 120 seconds.";
		const output = "remote: Counting objects: 100% (12/12), done.\nfatal: the remote end hung up unexpectedly";
		expect(getGitActionErrorPresentation(message, output)).toEqual({
			summary: message,
			details: `${message}\n\n${output}`,
		});
	});

	it("uses a fatal diagnostic over earlier errors and handles carriage-return progress", () => {
		const message =
			"Receiving objects: 20%\rReceiving objects: 100%\r\nerror: intermediate problem\nfatal: final reason";
		expect(getGitActionErrorPresentation(message, null).summary).toBe("fatal: final reason");
	});

	it("finds diagnostics in output when the message is a generic command failure", () => {
		expect(getGitActionErrorPresentation("Command failed: git fetch", "remote: error: access denied").summary).toBe(
			"remote: error: access denied",
		);
	});

	it("bounds a long unbroken summary without losing the full error-only details", () => {
		const message = `fatal: ${"x".repeat(2_000)}`;
		const result = getGitActionErrorPresentation(message, "");
		expect(result.summary.length).toBe(360);
		expect(result.summary.endsWith("…")).toBe(true);
		expect(result.details).toBe(message);
	});

	it("does not describe successful fetch output as the failure reason", () => {
		const message = "From /synthetic/origin\n * branch main -> FETCH_HEAD\nAlready up to date.";
		expect(getGitActionErrorPresentation(message, message).summary).toBe(
			"Git could not complete this action. View the details for more information.",
		);
	});

	it("preserves distinct messages and output while avoiding either containment duplicate", () => {
		expect(getGitActionErrorPresentation("fatal: failed", "fatal: failed").details).toBe("fatal: failed");
		expect(getGitActionErrorPresentation("prefix\nfatal: failed", "fatal: failed").details).toBe(
			"prefix\nfatal: failed",
		);
		expect(getGitActionErrorPresentation("Unable to fetch", "Additional diagnostic").details).toBe(
			"Unable to fetch\n\nAdditional diagnostic",
		);
	});
});
