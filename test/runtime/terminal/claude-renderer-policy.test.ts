import { describe, expect, it } from "vitest";

import {
	CLAUDE_CLASSIC_RENDERER_ENV_VAR,
	CLAUDE_FULLSCREEN_ENV_VAR,
	CLAUDE_SCROLL_SPEED_ENV_VAR,
	createClaudeRendererEnvironment,
	DEFAULT_CLAUDE_FULLSCREEN_SCROLL_SPEED,
	resolveClaudeRendererPolicy,
} from "../../../src/terminal/claude-renderer-policy";

describe("Claude renderer policy", () => {
	it("selects classic mode when the Quarterdeck setting is off", () => {
		expect(resolveClaudeRendererPolicy({ fullscreenEnabled: false, inheritedEnv: {} })).toEqual({
			mode: "classic",
			reason: "setting_disabled",
		});
	});

	it("selects fullscreen mode when enabled", () => {
		expect(resolveClaudeRendererPolicy({ fullscreenEnabled: true, inheritedEnv: {} })).toEqual({
			mode: "fullscreen",
			reason: "fullscreen_enabled",
		});
	});

	it("honors Claude's explicit classic-renderer escape hatch", () => {
		expect(
			resolveClaudeRendererPolicy({
				fullscreenEnabled: true,
				inheritedEnv: { [CLAUDE_CLASSIC_RENDERER_ENV_VAR]: "1" },
			}),
		).toEqual({ mode: "classic", reason: "classic_escape_hatch" });
	});

	it("lets a launch override disable an inherited escape hatch", () => {
		expect(
			resolveClaudeRendererPolicy({
				fullscreenEnabled: true,
				inheritedEnv: { [CLAUDE_CLASSIC_RENDERER_ENV_VAR]: "1" },
				envOverrides: { [CLAUDE_CLASSIC_RENDERER_ENV_VAR]: "0" },
			}),
		).toEqual({ mode: "fullscreen", reason: "fullscreen_enabled" });
	});

	it.each([
		{ args: ["--ax-screen-reader"], envOverrides: undefined },
		{ args: [], envOverrides: { CLAUDE_AX_SCREEN_READER: "1" } },
	])("keeps screen-reader launches on the classic renderer", ({ args, envOverrides }) => {
		expect(
			resolveClaudeRendererPolicy({
				fullscreenEnabled: true,
				args,
				envOverrides,
				inheritedEnv: {},
			}),
		).toEqual({ mode: "classic", reason: "screen_reader_mode" });
	});

	it("does not treat the screen-magnifier cursor aid as a classic-renderer constraint", () => {
		expect(
			resolveClaudeRendererPolicy({
				fullscreenEnabled: true,
				envOverrides: { CLAUDE_CODE_ACCESSIBILITY: "1" },
				inheritedEnv: {},
			}),
		).toEqual({ mode: "fullscreen", reason: "fullscreen_enabled" });
	});

	it("creates a deterministic launch environment for either mode", () => {
		expect(createClaudeRendererEnvironment("fullscreen", { inheritedEnv: {} })).toEqual({
			[CLAUDE_FULLSCREEN_ENV_VAR]: "1",
			[CLAUDE_SCROLL_SPEED_ENV_VAR]: DEFAULT_CLAUDE_FULLSCREEN_SCROLL_SPEED,
		});
		expect(createClaudeRendererEnvironment("classic")).toEqual({
			[CLAUDE_FULLSCREEN_ENV_VAR]: "0",
			[CLAUDE_CLASSIC_RENDERER_ENV_VAR]: "1",
		});
	});

	it("preserves an explicit fullscreen scroll-speed override", () => {
		expect(
			createClaudeRendererEnvironment("fullscreen", {
				inheritedEnv: { [CLAUDE_SCROLL_SPEED_ENV_VAR]: "5" },
			}),
		).toEqual({
			[CLAUDE_FULLSCREEN_ENV_VAR]: "1",
			[CLAUDE_SCROLL_SPEED_ENV_VAR]: "5",
		});
		expect(
			createClaudeRendererEnvironment("fullscreen", {
				envOverrides: { [CLAUDE_SCROLL_SPEED_ENV_VAR]: "7" },
				inheritedEnv: { [CLAUDE_SCROLL_SPEED_ENV_VAR]: "5" },
			}),
		).toEqual({
			[CLAUDE_FULLSCREEN_ENV_VAR]: "1",
			[CLAUDE_SCROLL_SPEED_ENV_VAR]: "7",
		});
	});
});
