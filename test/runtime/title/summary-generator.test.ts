import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../../src/title/llm-client", () => ({
	callLlm: vi.fn(),
}));

import { callLlm, generateDisplaySummary } from "../../../src/title";

const callLlmMock = vi.mocked(callLlm);

describe("generateDisplaySummary", () => {
	beforeEach(() => {
		callLlmMock.mockReset();
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("returns the LLM response when within the display limit", async () => {
		callLlmMock.mockResolvedValue("Added auth middleware and session validation");
		const result = await generateDisplaySummary("Long conversation about auth...");
		expect(result).toBe("Added auth middleware and session validation");
	});

	it("truncates LLM response exceeding the display limit with ellipsis", async () => {
		const longResponse = "A".repeat(100);
		callLlmMock.mockResolvedValue(longResponse);
		const result = await generateDisplaySummary("Some text");
		expect(result).not.toBeNull();
		expect(result?.length).toBe(91); // 90 chars + ellipsis
		expect(result?.endsWith("\u2026")).toBe(true);
	});

	it("returns null when LLM call fails", async () => {
		callLlmMock.mockResolvedValue(null);
		const result = await generateDisplaySummary("Some text");
		expect(result).toBeNull();
	});

	it("returns null for empty input", async () => {
		const result = await generateDisplaySummary("   ");
		expect(result).toBeNull();
		expect(callLlmMock).not.toHaveBeenCalled();
	});

	it("truncates input to 1800 chars before sending to LLM", async () => {
		callLlmMock.mockResolvedValue("Summary");
		const longInput = "X".repeat(3000);
		await generateDisplaySummary(longInput);
		expect(callLlmMock).toHaveBeenCalledTimes(1);
		const call = callLlmMock.mock.calls[0][0];
		expect(call.userPrompt.length).toBe(1800);
	});

	it("sends the correct system prompt and options", async () => {
		callLlmMock.mockResolvedValue("Summary");
		await generateDisplaySummary("Conversation text");
		expect(callLlmMock).toHaveBeenCalledWith(
			expect.objectContaining({
				maxTokens: 60,
				timeoutMs: 5_000,
			}),
		);
		const call = callLlmMock.mock.calls[0][0];
		expect(call.systemPrompt).toContain("75 characters");
		expect(call.systemPrompt).toContain("telegram-style");
	});
});
