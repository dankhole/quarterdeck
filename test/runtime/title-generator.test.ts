import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { generateBranchName, generateTaskTitle } from "../../src/title";

describe("generateTaskTitle", () => {
	const originalEnv = { ...process.env };

	beforeEach(() => {
		process.env.QUARTERDECK_LLM_BASE_URL = "https://llm.example.com/v1";
		process.env.QUARTERDECK_LLM_API_KEY = "test-token";
		process.env.QUARTERDECK_LLM_MODEL = "test-model";
	});

	afterEach(() => {
		process.env = { ...originalEnv };
		vi.restoreAllMocks();
	});

	it("returns a title from a successful LLM response", async () => {
		vi.spyOn(globalThis, "fetch").mockResolvedValue(
			new Response(
				JSON.stringify({
					choices: [{ message: { content: "Fix Auth Bug" } }],
				}),
				{ status: 200 },
			),
		);

		const title = await generateTaskTitle("fix the authentication bug in login.ts");
		expect(title).toBe("Fix Auth Bug");
	});

	it("builds the chat completions URL from a v1 base URL", async () => {
		const fetchSpy = vi
			.spyOn(globalThis, "fetch")
			.mockResolvedValue(
				new Response(JSON.stringify({ choices: [{ message: { content: "Title" } }] }), { status: 200 }),
			);

		await generateTaskTitle("some prompt");
		expect(fetchSpy).toHaveBeenCalledWith(
			"https://llm.example.com/v1/chat/completions",
			expect.objectContaining({ method: "POST" }),
		);
	});

	it("uses generic OpenAI-compatible LLM env vars when configured", async () => {
		process.env.QUARTERDECK_LLM_BASE_URL = "https://llm.example.com/v1";
		process.env.QUARTERDECK_LLM_API_KEY = "generic-token";
		process.env.QUARTERDECK_LLM_MODEL = "test-model";
		const fetchSpy = vi
			.spyOn(globalThis, "fetch")
			.mockResolvedValue(
				new Response(JSON.stringify({ choices: [{ message: { content: "Generic Title" } }] }), { status: 200 }),
			);

		await generateTaskTitle("fix the authentication bug in login.ts");
		expect(fetchSpy).toHaveBeenCalledWith(
			"https://llm.example.com/v1/chat/completions",
			expect.objectContaining({
				headers: expect.objectContaining({ authorization: "Bearer generic-token" }),
				method: "POST",
			}),
		);
		const body = JSON.parse(fetchSpy.mock.calls[0][1]?.body as string);
		expect(body.model).toBe("test-model");
	});

	it("falls back when env vars are missing", async () => {
		delete process.env.QUARTERDECK_LLM_BASE_URL;
		expect(await generateTaskTitle("fix the authentication bug in login.ts")).toBe("Fix Authentication Bug Login");
	});

	it("falls back when API key is missing", async () => {
		delete process.env.QUARTERDECK_LLM_API_KEY;
		expect(await generateTaskTitle("fix the authentication bug in login.ts")).toBe("Fix Authentication Bug Login");
	});

	it("falls back on non-ok response", async () => {
		vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("error", { status: 500 }));
		expect(await generateTaskTitle("fix the authentication bug in login.ts")).toBe("Fix Authentication Bug Login");
	});

	it("falls back on network error", async () => {
		vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("network failure"));
		expect(await generateTaskTitle("fix the authentication bug in login.ts")).toBe("Fix Authentication Bug Login");
	});

	it("falls back on timeout", async () => {
		vi.spyOn(globalThis, "fetch").mockRejectedValue(
			new DOMException("The operation was aborted due to timeout", "TimeoutError"),
		);
		expect(await generateTaskTitle("fix the authentication bug in login.ts")).toBe("Fix Authentication Bug Login");
	});

	it("falls back when response has no choices", async () => {
		vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify({}), { status: 200 }));
		expect(await generateTaskTitle("fix the authentication bug in login.ts")).toBe("Fix Authentication Bug Login");
	});

	it("trims whitespace from the returned title", async () => {
		vi.spyOn(globalThis, "fetch").mockResolvedValue(
			new Response(JSON.stringify({ choices: [{ message: { content: "  Spaced Title  " } }] }), { status: 200 }),
		);
		expect(await generateTaskTitle("some prompt")).toBe("Spaced Title");
	});

	it("keeps the title and drops trailing transcript echoes", async () => {
		vi.spyOn(globalThis, "fetch").mockResolvedValue(
			new Response(
				JSON.stringify({
					choices: [
						{
							message: {
								content: "Generate Title Failure\nHuman generated\nHuman: I see you generated a title.",
							},
						},
					],
				}),
				{ status: 200 },
			),
		);
		expect(await generateTaskTitle("investigate title generation failure")).toBe("Generate Title Failure");
	});

	it("keeps the title when a transcript echo is collapsed onto one line", async () => {
		vi.spyOn(globalThis, "fetch").mockResolvedValue(
			new Response(
				JSON.stringify({
					choices: [
						{
							message: {
								content: "Generate Title Failure Human generated Human: I see you generated a title.",
							},
						},
					],
				}),
				{ status: 200 },
			),
		);
		expect(await generateTaskTitle("investigate title generation failure")).toBe("Generate Title Failure");
	});

	it("keeps legitimate human generated title text", async () => {
		vi.spyOn(globalThis, "fetch").mockResolvedValue(
			new Response(
				JSON.stringify({
					choices: [{ message: { content: "Handle Human Generated Content" } }],
				}),
				{ status: 200 },
			),
		);
		expect(await generateTaskTitle("handle human generated content")).toBe("Handle Human Generated Content");
	});

	it("falls back when the returned title is only a transcript echo", async () => {
		vi.spyOn(globalThis, "fetch").mockResolvedValue(
			new Response(
				JSON.stringify({
					choices: [{ message: { content: "Human generated\nHuman: I see you generated a title." } }],
				}),
				{ status: 200 },
			),
		);
		expect(await generateTaskTitle("fix the authentication bug in login.ts")).toBe("Fix Authentication Bug Login");
	});

	it("falls back when the returned title is only a collapsed transcript echo", async () => {
		vi.spyOn(globalThis, "fetch").mockResolvedValue(
			new Response(
				JSON.stringify({
					choices: [{ message: { content: "Human generated Human: I see you generated a title." } }],
				}),
				{ status: 200 },
			),
		);
		expect(await generateTaskTitle("fix the authentication bug in login.ts")).toBe("Fix Authentication Bug Login");
	});

	it("truncates title prompts longer than 1200 characters", async () => {
		const fetchSpy = vi
			.spyOn(globalThis, "fetch")
			.mockResolvedValue(
				new Response(JSON.stringify({ choices: [{ message: { content: "Title" } }] }), { status: 200 }),
			);

		const longPrompt = "x".repeat(2000);
		await generateTaskTitle(longPrompt);

		const body = JSON.parse(fetchSpy.mock.calls[0][1]?.body as string);
		expect(body.messages[1].content).toHaveLength(1200);
	});
});

describe("generateBranchName", () => {
	const originalEnv = { ...process.env };

	beforeEach(() => {
		process.env.QUARTERDECK_LLM_BASE_URL = "https://llm.example.com/v1";
		process.env.QUARTERDECK_LLM_API_KEY = "test-token";
		process.env.QUARTERDECK_LLM_MODEL = "test-model";
	});

	afterEach(() => {
		process.env = { ...originalEnv };
		vi.restoreAllMocks();
	});

	it("returns a branch name from a successful LLM response", async () => {
		vi.spyOn(globalThis, "fetch").mockResolvedValue(
			new Response(
				JSON.stringify({
					choices: [{ message: { content: "fix-auth-bug" } }],
				}),
				{ status: 200 },
			),
		);

		const name = await generateBranchName("fix the authentication bug in login.ts");
		expect(name).toBe("fix-auth-bug");
	});

	it("uses the branch name system prompt, not the title prompt", async () => {
		const fetchSpy = vi
			.spyOn(globalThis, "fetch")
			.mockResolvedValue(
				new Response(JSON.stringify({ choices: [{ message: { content: "fix-bug" } }] }), { status: 200 }),
			);

		await generateBranchName("some prompt");
		const body = JSON.parse(fetchSpy.mock.calls[0][1]?.body as string);
		const systemMessage = body.messages[0].content as string;
		expect(systemMessage).toContain("git branch name");
		expect(systemMessage).not.toContain("title");
	});

	it("returns null when env vars are missing", async () => {
		delete process.env.QUARTERDECK_LLM_BASE_URL;
		expect(await generateBranchName("some prompt")).toBeNull();
	});

	it("returns null on non-ok response", async () => {
		vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("error", { status: 500 }));
		expect(await generateBranchName("some prompt")).toBeNull();
	});

	it("returns null on network error", async () => {
		vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("network failure"));
		expect(await generateBranchName("some prompt")).toBeNull();
	});

	it("truncates branch prompts longer than 1200 characters", async () => {
		const fetchSpy = vi
			.spyOn(globalThis, "fetch")
			.mockResolvedValue(
				new Response(JSON.stringify({ choices: [{ message: { content: "fix-bug" } }] }), { status: 200 }),
			);

		await generateBranchName("x".repeat(2000));

		const body = JSON.parse(fetchSpy.mock.calls[0][1]?.body as string);
		expect(body.messages[1].content).toHaveLength(1200);
	});
});
