import { describe, expect, it } from "vitest";

import { statuslineInputSchema } from "../../../src/commands/statusline";

function input(contextWindow: Record<string, unknown>) {
	return {
		model: { display_name: "Opus" },
		session_id: "session-1",
		cwd: "/tmp/repo",
		cost: { total_cost_usd: 0, total_duration_ms: 0, total_lines_added: 0, total_lines_removed: 0 },
		context_window: { context_window_size: 200_000, ...contextWindow },
	};
}

describe("statuslineInputSchema", () => {
	it("accepts null usage fields sent before the first response", () => {
		const parsed = statuslineInputSchema.safeParse(
			input({ used_percentage: null, total_input_tokens: 0, total_output_tokens: 0, current_usage: null }),
		);

		expect(parsed.success).toBe(true);
	});

	it("accepts null cache counters inside current usage", () => {
		const parsed = statuslineInputSchema.safeParse(
			input({
				used_percentage: 12,
				current_usage: { input_tokens: 10, cache_creation_input_tokens: null, cache_read_input_tokens: null },
			}),
		);

		expect(parsed.success).toBe(true);
	});

	it("still rejects a missing context window size", () => {
		const parsed = statuslineInputSchema.safeParse({ ...input({}), context_window: { used_percentage: 1 } });

		expect(parsed.success).toBe(false);
	});
});
