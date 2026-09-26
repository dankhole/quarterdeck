import { describe, expect, it } from "vitest";
import { createClaudeRendererEnvironment } from "../../../src/terminal/claude-renderer-policy";

describe("Claude fullscreen launch environment", () => {
	it("forces fullscreen regardless of inherited or launch renderer preferences", () => {
		expect(
			createClaudeRendererEnvironment({
				inheritedEnv: { CLAUDE_CODE_NO_FLICKER: "0", CLAUDE_CODE_DISABLE_ALTERNATE_SCREEN: "1" },
				envOverrides: { CLAUDE_CODE_NO_FLICKER: "0", CLAUDE_CODE_DISABLE_ALTERNATE_SCREEN: "1" },
			}),
		).toEqual({
			CLAUDE_CODE_NO_FLICKER: "1",
			CLAUDE_CODE_DISABLE_ALTERNATE_SCREEN: "0",
			CLAUDE_CODE_SCROLL_SPEED: "3",
		});
	});
	it("preserves explicit scroll speed and defaults blank values", () => {
		for (const [envOverrides, expected] of [
			[undefined, "5"],
			[{ CLAUDE_CODE_SCROLL_SPEED: "7" }, "7"],
			[{ CLAUDE_CODE_SCROLL_SPEED: " " }, "3"],
		] as const) {
			expect(
				createClaudeRendererEnvironment({ envOverrides, inheritedEnv: { CLAUDE_CODE_SCROLL_SPEED: "5" } })
					.CLAUDE_CODE_SCROLL_SPEED,
			).toBe(expected);
		}
	});
	it.each([
		{ args: ["--ax-screen-reader"] },
		{ inheritedEnv: { CLAUDE_AX_SCREEN_READER: "1" } },
		{ envOverrides: { CLAUDE_AX_SCREEN_READER: "true" } },
	])("rejects screen-reader mode rather than silently launching classic", (options) => {
		expect(() => createClaudeRendererEnvironment({ inheritedEnv: {}, ...options })).toThrow(
			"Quarterdeck requires Claude fullscreen rendering",
		);
	});
	it("allows an explicitly disabled inherited screen-reader mode and the screen-magnifier aid", () => {
		expect(
			createClaudeRendererEnvironment({
				inheritedEnv: { CLAUDE_AX_SCREEN_READER: "1" },
				envOverrides: { CLAUDE_AX_SCREEN_READER: "0", CLAUDE_CODE_ACCESSIBILITY: "1" },
			}).CLAUDE_CODE_NO_FLICKER,
		).toBe("1");
	});
});
