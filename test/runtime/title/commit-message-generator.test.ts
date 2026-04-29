import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../../src/title/llm-client", () => ({
	callLlm: vi.fn(),
}));

import { callLlm, createFallbackCommitMessage, generateCommitMessage } from "../../../src/title";

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

describe("generateCommitMessage", () => {
	beforeEach(() => {
		callLlmMock.mockReset();
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("returns the LLM response when generation succeeds", async () => {
		callLlmMock.mockResolvedValue("fix auth mode");
		await expect(generateCommitMessage(SINGLE_FILE_DIFF)).resolves.toBe("fix auth mode");
	});

	it("returns a diff-derived fallback when LLM generation fails", async () => {
		callLlmMock.mockResolvedValue(null);
		const result = await generateCommitMessage(SINGLE_FILE_DIFF);
		expect(result).toBe("update auth.ts\n\n- Update 1 file, +2/-1\n- Touch auth.ts");
	});

	it("returns null when diff is empty", async () => {
		await expect(generateCommitMessage("   ")).resolves.toBeNull();
		expect(callLlmMock).not.toHaveBeenCalled();
	});

	it("truncates input to 3000 chars before sending to LLM", async () => {
		callLlmMock.mockResolvedValue("update files");
		await generateCommitMessage(`${SINGLE_FILE_DIFF}${"x".repeat(4000)}`);
		expect(callLlmMock).toHaveBeenCalledTimes(1);
		const call = callLlmMock.mock.calls[0][0];
		expect(call.userPrompt.length).toBe(3000);
	});
});

describe("createFallbackCommitMessage", () => {
	it("summarizes added files", () => {
		const diff = `diff --git a/docs/guide.md b/docs/guide.md
new file mode 100644
--- /dev/null
+++ b/docs/guide.md
@@ -0,0 +1 @@
+Guide
`;
		expect(createFallbackCommitMessage(diff)?.split("\n", 1)[0]).toBe("add guide.md");
	});

	it("summarizes multi-file docs changes by area", () => {
		const diff = `diff --git a/docs/a.md b/docs/a.md
--- a/docs/a.md
+++ b/docs/a.md
@@ -1 +1 @@
-Old
+New
diff --git a/docs/b.md b/docs/b.md
--- a/docs/b.md
+++ b/docs/b.md
@@ -1 +1 @@
-Old
+New
`;
		expect(createFallbackCommitMessage(diff)?.split("\n", 1)[0]).toBe("update docs");
	});

	it("returns null when no diff files are present", () => {
		expect(createFallbackCommitMessage("not a git diff")).toBeNull();
	});
});
