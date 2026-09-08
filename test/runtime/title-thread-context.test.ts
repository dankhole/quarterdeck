import { describe, expect, it } from "vitest";
import type { ConversationEntry, ConversationMessageEntry } from "../../src/conversation/contracts";
import { buildTitleThreadContext, MAX_TITLE_CONTEXT_LENGTH } from "../../src/title/title-thread-context";

function message(role: "user" | "assistant", text: string, id = text): ConversationMessageEntry {
	return { type: "message", id, role, text };
}

describe("buildTitleThreadContext", () => {
	it("puts evolving user direction and its replies ahead of the brief original request", () => {
		const entries: ConversationEntry[] = [
			message("user", "Check the sorting options"),
			message("assistant", "The larger issue is the search and recommendation layout"),
			{ type: "boundary", id: "restart", kind: "restarted" },
			message("user", "Yes, improve the whole search and recommendation experience"),
			message("assistant", "Updated the result cards and recommendation navigation"),
			message("user", "Run the tests too"),
		];
		const context = buildTitleThreadContext({ prompt: "Check the sorting options", entries });
		expect(context).toContain("User:\nYes, improve the whole search and recommendation experience");
		expect(context).toContain("Assistant:\nThe larger issue is the search and recommendation layout");
		expect(context).not.toContain("restarted");
		expect(context?.indexOf("Yes, improve")).toBeLessThan(context?.indexOf("Run the tests") ?? 0);
		expect(context?.endsWith("Original request (background only):\nCheck the sorting options")).toBe(true);
	});

	it("bounds long transcripts while preserving recent user steering and both ends of long replies", () => {
		const entries: ConversationEntry[] = [];
		for (let index = 0; index < 20; index++) {
			entries.push(message("user", `Request ${index}: ${"detail ".repeat(400)} Closing correction ${index}`));
			entries.push(message("assistant", `Reply ${index}: ${"output ".repeat(2_000)} Actual outcome ${index}`));
		}
		const context = buildTitleThreadContext({ prompt: "background ".repeat(1_000), entries });
		expect(context?.length).toBeLessThanOrEqual(MAX_TITLE_CONTEXT_LENGTH);
		expect(context).toContain("Request 19:");
		expect(context).toContain("Closing correction 19");
		expect(context).toContain("Request 18:");
		expect(context).toContain("Actual outcome 19");
		expect(context).not.toContain("Request 0:");
	});

	it("keeps short acceptances with the preceding proposal", () => {
		const context = buildTitleThreadContext({
			prompt: "Review the dashboard",
			entries: [
				message("assistant", "Reorganize the dashboard around project health and deployment status"),
				message("user", "Yes, do that"),
			],
		});
		expect(context).toContain("Reorganize the dashboard around project health and deployment status");
		expect(context).toContain("Yes, do that");
	});

	it("appends a fresh hook completion when the transcript has not caught up", () => {
		expect(
			buildTitleThreadContext({
				prompt: "Inspect the integration",
				entries: [message("user", "Finish the integration")],
				finalMessage: "Implemented the integration",
			}),
		).toContain("Assistant (latest completion):\nImplemented the integration");
		const context = buildTitleThreadContext({
			prompt: "Inspect the integration",
			entries: [message("assistant", "Earlier investigation"), message("user", "Finish the integration")],
			finalMessage: "Implemented the integration",
		});
		expect(context).toContain("Assistant (latest completion):\nImplemented the integration");
		expect(context?.indexOf("Finish the integration")).toBeLessThan(
			context?.indexOf("Implemented the integration") ?? 0,
		);
	});

	it("does not repeat a completion already present in the transcript", () => {
		const context = buildTitleThreadContext({
			prompt: "Inspect the integration",
			entries: [message("assistant", "Implemented the integration")],
			finalMessage: "Implemented  the integration\n",
		});
		expect(context).not.toContain("latest completion");
		expect(context?.match(/Implemented/g)).toHaveLength(1);
	});

	it("preserves both ends of the initial request when no conversation is available", () => {
		const context = buildTitleThreadContext({
			prompt: `Opening subject ${"background ".repeat(1_000)} Actual closing request`,
			entries: [],
		});
		expect(context).toHaveLength(MAX_TITLE_CONTEXT_LENGTH);
		expect(context?.startsWith("Opening subject")).toBe(true);
		expect(context?.endsWith("Actual closing request")).toBe(true);
		expect(buildTitleThreadContext({ prompt: " ", entries: [] })).toBeNull();
	});
});
