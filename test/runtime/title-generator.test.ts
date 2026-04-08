import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { generateBranchName, generateTaskTitle } from "../../src/title/title-generator";

describe("generateTaskTitle", () => {
	const originalEnv = { ...process.env };

	beforeEach(() => {
		process.env.ANTHROPIC_BEDROCK_BASE_URL = "https://proxy.example.com/bedrock";
		process.env.ANTHROPIC_AUTH_TOKEN = "test-token";
		delete process.env.QUARTERDECK_TITLE_MODEL;
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

	it("strips the /bedrock suffix to build the completions URL", async () => {
		const fetchSpy = vi
			.spyOn(globalThis, "fetch")
			.mockResolvedValue(
				new Response(JSON.stringify({ choices: [{ message: { content: "Title" } }] }), { status: 200 }),
			);

		await generateTaskTitle("some prompt");
		expect(fetchSpy).toHaveBeenCalledWith(
			"https://proxy.example.com/v1/chat/completions",
			expect.objectContaining({ method: "POST" }),
		);
	});

	it("returns null when env vars are missing", async () => {
		delete process.env.ANTHROPIC_BEDROCK_BASE_URL;
		expect(await generateTaskTitle("some prompt")).toBeNull();
	});

	it("returns null when auth token is missing", async () => {
		delete process.env.ANTHROPIC_AUTH_TOKEN;
		expect(await generateTaskTitle("some prompt")).toBeNull();
	});

	it("returns null on non-ok response", async () => {
		vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("error", { status: 500 }));
		expect(await generateTaskTitle("some prompt")).toBeNull();
	});

	it("returns null on network error", async () => {
		vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("network failure"));
		expect(await generateTaskTitle("some prompt")).toBeNull();
	});

	it("returns null when response has no choices", async () => {
		vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify({}), { status: 200 }));
		expect(await generateTaskTitle("some prompt")).toBeNull();
	});

	it("trims whitespace from the returned title", async () => {
		vi.spyOn(globalThis, "fetch").mockResolvedValue(
			new Response(JSON.stringify({ choices: [{ message: { content: "  Spaced Title  " } }] }), { status: 200 }),
		);
		expect(await generateTaskTitle("some prompt")).toBe("Spaced Title");
	});

	it("truncates prompts longer than 800 characters", async () => {
		const fetchSpy = vi
			.spyOn(globalThis, "fetch")
			.mockResolvedValue(
				new Response(JSON.stringify({ choices: [{ message: { content: "Title" } }] }), { status: 200 }),
			);

		const longPrompt = "x".repeat(1000);
		await generateTaskTitle(longPrompt);

		const body = JSON.parse(fetchSpy.mock.calls[0][1]?.body as string);
		expect(body.messages[1].content).toHaveLength(800);
	});

	it("uses QUARTERDECK_TITLE_MODEL env var when set", async () => {
		process.env.QUARTERDECK_TITLE_MODEL = "custom/model-id";
		const fetchSpy = vi
			.spyOn(globalThis, "fetch")
			.mockResolvedValue(
				new Response(JSON.stringify({ choices: [{ message: { content: "Title" } }] }), { status: 200 }),
			);

		await generateTaskTitle("some prompt");
		const body = JSON.parse(fetchSpy.mock.calls[0][1]?.body as string);
		expect(body.model).toBe("custom/model-id");
	});
});

describe("generateBranchName", () => {
	const originalEnv = { ...process.env };

	beforeEach(() => {
		process.env.ANTHROPIC_BEDROCK_BASE_URL = "https://proxy.example.com/bedrock";
		process.env.ANTHROPIC_AUTH_TOKEN = "test-token";
		delete process.env.QUARTERDECK_TITLE_MODEL;
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
		delete process.env.ANTHROPIC_BEDROCK_BASE_URL;
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
});
