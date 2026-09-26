export const CLAUDE_SCROLL_SPEED_ENV_VAR = "CLAUDE_CODE_SCROLL_SPEED";
export const DEFAULT_CLAUDE_FULLSCREEN_SCROLL_SPEED = "3";

/** Quarterdeck supports only Claude's fullscreen renderer. */
export function createClaudeRendererEnvironment({
	args = [],
	envOverrides,
	inheritedEnv = process.env,
}: {
	args?: readonly string[];
	envOverrides?: Record<string, string | undefined>;
	inheritedEnv?: Record<string, string | undefined>;
} = {}): Record<string, string> {
	const screenReader = envOverrides?.CLAUDE_AX_SCREEN_READER ?? inheritedEnv.CLAUDE_AX_SCREEN_READER;
	if (
		args.includes("--ax-screen-reader") ||
		["1", "true", "yes", "on"].includes(screenReader?.trim().toLowerCase() ?? "")
	) {
		throw new Error(
			"Quarterdeck requires Claude fullscreen rendering. Remove --ax-screen-reader or disable CLAUDE_AX_SCREEN_READER before starting this task.",
		);
	}
	return {
		CLAUDE_CODE_NO_FLICKER: "1",
		CLAUDE_CODE_DISABLE_ALTERNATE_SCREEN: "0",
		[CLAUDE_SCROLL_SPEED_ENV_VAR]:
			(envOverrides?.[CLAUDE_SCROLL_SPEED_ENV_VAR] ?? inheritedEnv[CLAUDE_SCROLL_SPEED_ENV_VAR])?.trim() ||
			DEFAULT_CLAUDE_FULLSCREEN_SCROLL_SPEED,
	};
}
