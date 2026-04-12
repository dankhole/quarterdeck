import { describe, expect, it } from "vitest";

import {
	hasCodexWorkspaceTrustPrompt,
	shouldAutoConfirmCodexWorkspaceTrust,
} from "../../../src/terminal/codex-workspace-trust";

describe("hasCodexWorkspaceTrustPrompt", () => {
	it("returns true for plain 'Do you trust the contents of this directory?' text", () => {
		const prompt =
			"Do you trust the contents of this directory? Working with untrusted contents comes with higher risk.";
		expect(hasCodexWorkspaceTrustPrompt(prompt)).toBe(true);
	});

	it("returns true with ANSI codes interspersed", () => {
		const ansiPrompt =
			"Do you trust the \u001b[31mcontents\u001b[0m of this directory? Working with untrusted contents.";
		expect(hasCodexWorkspaceTrustPrompt(ansiPrompt)).toBe(true);
	});

	it("returns true for realistic multi-line Codex trust prompt", () => {
		const codexPrompt = `
You are in /Users/saoud/.quarterdeck/worktrees/6df3a/mcp-swift-sdk

Do you trust the contents of this directory? Working with untrusted
contents comes with higher risk of prompt injection.

› 1. Yes, continue
  2. No, quit

Press enter to continue`;
		expect(hasCodexWorkspaceTrustPrompt(codexPrompt)).toBe(true);
	});

	it("returns true with extra whitespace and newlines between tokens", () => {
		const spaceyPrompt = "Do  you\n  trust   the\n\tcontents  of\n  this   directory";
		expect(hasCodexWorkspaceTrustPrompt(spaceyPrompt)).toBe(true);
	});

	it("returns false for 'Do you trust this directory?' (missing 'contents of')", () => {
		expect(hasCodexWorkspaceTrustPrompt("Do you trust this directory?")).toBe(false);
	});

	it("returns false for empty string", () => {
		expect(hasCodexWorkspaceTrustPrompt("")).toBe(false);
	});

	it("returns false for unrelated text", () => {
		expect(hasCodexWorkspaceTrustPrompt("Running tests in /home/user/project")).toBe(false);
	});
});

describe("shouldAutoConfirmCodexWorkspaceTrust", () => {
	it("returns true for codex agent with any cwd", () => {
		expect(shouldAutoConfirmCodexWorkspaceTrust("codex", "/any/path")).toBe(true);
		expect(shouldAutoConfirmCodexWorkspaceTrust("codex", "/home/user/project")).toBe(true);
	});

	it("returns false for claude agent", () => {
		expect(shouldAutoConfirmCodexWorkspaceTrust("claude", "/any/path")).toBe(false);
	});

	it("returns false for other agent ids", () => {
		expect(shouldAutoConfirmCodexWorkspaceTrust("other" as any, "/any/path")).toBe(false);
	});
});
