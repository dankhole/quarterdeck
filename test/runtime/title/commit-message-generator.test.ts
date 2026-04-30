import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../../src/title/llm-client", () => ({
	callLlm: vi.fn(),
}));

import {
	buildCommitMessagePromptContext,
	callLlm,
	generateCommitMessage,
	type RuntimeCommitMessageGenerationContext,
} from "../../../src/title";

const callLlmMock = vi.mocked(callLlm);

const SINGLE_FILE_DIFF = `diff --git a/src/auth.ts b/src/auth.ts
index 1111111..2222222 100644
--- a/src/auth.ts
+++ b/src/auth.ts
@@ -1,3 +1,4 @@
-export const enabled = false;
+export const enabled = true;
+export const mode = "strict";
`;

function createContext(
	overrides: Partial<RuntimeCommitMessageGenerationContext> = {},
): RuntimeCommitMessageGenerationContext {
	return {
		taskTitle: null,
		taskContext: null,
		files: [
			{
				path: "src/auth.ts",
				status: "modified",
				additions: 2,
				deletions: 1,
			},
		],
		diffText: SINGLE_FILE_DIFF,
		untrackedFileContents: [],
		untrackedContentOmittedCount: 0,
		...overrides,
	};
}

describe("generateCommitMessage", () => {
	beforeEach(() => {
		callLlmMock.mockReset();
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("returns the LLM response when generation succeeds", async () => {
		callLlmMock.mockResolvedValue("fix auth mode");
		await expect(generateCommitMessage(createContext())).resolves.toBe("fix auth mode");
	});

	it("returns null when LLM generation fails", async () => {
		callLlmMock.mockResolvedValue(null);
		await expect(generateCommitMessage(createContext())).resolves.toBeNull();
	});

	it("returns null when context is empty", async () => {
		await expect(
			generateCommitMessage(
				createContext({
					files: [],
					diffText: "   ",
				}),
			),
		).resolves.toBeNull();
		expect(callLlmMock).not.toHaveBeenCalled();
	});

	it("sends selected files and a larger bounded change context to the LLM", async () => {
		callLlmMock.mockResolvedValue("update files");
		await generateCommitMessage(
			createContext({
				files: [
					{
						path: "src/auth.ts",
						status: "modified",
						additions: 2,
						deletions: 1,
					},
					{
						path: "docs/long-name-that-must-survive-truncation.md",
						status: "modified",
						additions: 1,
						deletions: 0,
					},
				],
				diffText: `${SINGLE_FILE_DIFF}${"x".repeat(40_000)}`,
			}),
		);
		expect(callLlmMock).toHaveBeenCalledTimes(1);
		const call = callLlmMock.mock.calls[0][0];
		expect(call.userPrompt).toContain("Selected files (2; complete list):");
		expect(call.userPrompt).toContain("docs/long-name-that-must-survive-truncation.md");
		expect(call.userPrompt).toContain("Unified diff truncated after");
		expect(call.userPrompt.length).toBeGreaterThan(20_000);
		expect(call.maxTokens).toBe(400);
		expect(call.timeoutMs).toBe(12_000);
	});
});

describe("buildCommitMessagePromptContext", () => {
	it("includes task context when available", () => {
		const prompt = buildCommitMessagePromptContext(
			createContext({
				taskTitle: "Improve generated commit messages",
				taskContext: "Original prompt:\nMake generated commit messages less generic.",
			}),
		);
		expect(prompt).toContain("Task title:\nImprove generated commit messages");
		expect(prompt).toContain("Original prompt:\nMake generated commit messages less generic.");
	});

	it("includes untracked file content excerpts when available", () => {
		const prompt = buildCommitMessagePromptContext(
			createContext({
				files: [
					{
						path: "notes/new-plan.md",
						status: "untracked",
						additions: 3,
						deletions: 0,
					},
				],
				diffText: "",
				untrackedFileContents: [{ path: "notes/new-plan.md", content: "# Plan\n\nDetails", truncated: false }],
			}),
		);
		expect(prompt).toContain("- untracked +3/-0 notes/new-plan.md");
		expect(prompt).toContain("Untracked file content excerpts:");
		expect(prompt).toContain("# Plan");
	});

	it("preserves untracked excerpts when tracked diff is long", () => {
		const prompt = buildCommitMessagePromptContext(
			createContext({
				diffText: `diff --git a/src/generated.ts b/src/generated.ts\n${"x".repeat(40_000)}`,
				untrackedFileContents: [{ path: "notes/new-plan.md", content: "# Plan\n\nDetails", truncated: false }],
			}),
		);
		expect(prompt).toContain("Unified diff truncated after");
		expect(prompt).toContain("Untracked file content excerpts:");
		expect(prompt).toContain("# Plan");
	});

	it("marks omitted untracked content without including file bytes", () => {
		const prompt = buildCommitMessagePromptContext(
			createContext({
				diffText: "",
				untrackedFileContents: [
					{
						path: "asset.bin",
						content: "",
						truncated: false,
						omittedReason: "binary",
					},
				],
			}),
		);
		expect(prompt).toContain("--- asset.bin");
		expect(prompt).toContain("[binary untracked file content omitted]");
	});
});
