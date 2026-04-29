import { describe, expect, it } from "vitest";

import { appendMetadataFlags, normalizeHookMetadata, parseMetadataFromOptions } from "../../src/commands/hook-metadata";

describe("hook metadata", () => {
	it("parses and forwards tool input summaries from hook flags", () => {
		const metadata = parseMetadataFromOptions({
			source: " pi ",
			toolName: " bash ",
			toolInputSummary: " npm test ",
		});

		expect(metadata).toEqual({
			source: "pi",
			toolName: "bash",
			toolInputSummary: "npm test",
		});

		expect(appendMetadataFlags(["hooks", "notify"], metadata)).toEqual([
			"hooks",
			"notify",
			"--source",
			"pi",
			"--tool-name",
			"bash",
			"--tool-input-summary",
			"npm test",
		]);
	});

	it("infers a compact tool input summary from structured hook payloads", () => {
		const metadata = normalizeHookMetadata(
			"activity",
			{
				hookEventName: "PreToolUse",
				toolName: "Bash",
				tool_input: {
					command: "npm run typecheck",
				},
			},
			{},
		);

		expect(metadata).toEqual(
			expect.objectContaining({
				hookEventName: "PreToolUse",
				toolName: "Bash",
				toolInputSummary: "Bash: npm run typecheck",
				activityText: "Using Bash: npm run typecheck",
			}),
		);
	});
});
