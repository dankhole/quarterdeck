export const CLAUDE_FULLSCREEN_ENV_VAR = "CLAUDE_CODE_NO_FLICKER";
export const CLAUDE_CLASSIC_RENDERER_ENV_VAR = "CLAUDE_CODE_DISABLE_ALTERNATE_SCREEN";
export const CLAUDE_SCROLL_SPEED_ENV_VAR = "CLAUDE_CODE_SCROLL_SPEED";
export const DEFAULT_CLAUDE_FULLSCREEN_SCROLL_SPEED = "3";
const CLAUDE_SCREEN_READER_ENV_VAR = "CLAUDE_AX_SCREEN_READER";
const CLAUDE_SCREEN_READER_ARG = "--ax-screen-reader";

export type ClaudeRendererMode = "classic" | "fullscreen";
export type ClaudeRendererReason =
	| "setting_disabled"
	| "classic_escape_hatch"
	| "screen_reader_mode"
	| "fullscreen_enabled";

export interface ClaudeRendererPolicy {
	mode: ClaudeRendererMode;
	reason: ClaudeRendererReason;
}

interface ResolveClaudeRendererPolicyOptions {
	fullscreenEnabled?: boolean;
	args?: readonly string[];
	envOverrides?: Record<string, string | undefined>;
	inheritedEnv?: Record<string, string | undefined>;
}

function resolveEnvironmentValue(
	key: string,
	envOverrides: Record<string, string | undefined> | undefined,
	inheritedEnv: Record<string, string | undefined>,
): string | undefined {
	return envOverrides?.[key] ?? inheritedEnv[key];
}

function isEnabledEnvironmentValue(value: string | undefined): boolean {
	const normalized = value?.trim().toLowerCase();
	return normalized === "1" || normalized === "true" || normalized === "yes" || normalized === "on";
}

/**
 * Resolve the renderer Quarterdeck should expect Claude to launch with.
 *
 * The explicit classic-renderer environment variable is Claude's documented
 * escape hatch and takes precedence over Quarterdeck's experimental setting.
 * Keeping that precedence in this pure policy prevents the PTY row strategy
 * from disagreeing with the renderer Claude actually selects.
 */
export function resolveClaudeRendererPolicy({
	fullscreenEnabled,
	args = [],
	envOverrides,
	inheritedEnv = process.env,
}: ResolveClaudeRendererPolicyOptions): ClaudeRendererPolicy {
	if (fullscreenEnabled !== true) {
		return { mode: "classic", reason: "setting_disabled" };
	}

	const classicEscapeHatch = resolveEnvironmentValue(CLAUDE_CLASSIC_RENDERER_ENV_VAR, envOverrides, inheritedEnv);
	if (classicEscapeHatch?.trim() === "1") {
		return { mode: "classic", reason: "classic_escape_hatch" };
	}
	const screenReaderModeEnabled =
		args.includes(CLAUDE_SCREEN_READER_ARG) ||
		isEnabledEnvironmentValue(resolveEnvironmentValue(CLAUDE_SCREEN_READER_ENV_VAR, envOverrides, inheritedEnv));
	if (screenReaderModeEnabled) {
		return { mode: "classic", reason: "screen_reader_mode" };
	}

	return { mode: "fullscreen", reason: "fullscreen_enabled" };
}

/** Return the launch-local environment that makes the resolved mode deterministic. */
export function createClaudeRendererEnvironment(
	mode: ClaudeRendererMode,
	options: {
		envOverrides?: Record<string, string | undefined>;
		inheritedEnv?: Record<string, string | undefined>;
	} = {},
): Record<string, string> {
	if (mode === "fullscreen") {
		return {
			[CLAUDE_FULLSCREEN_ENV_VAR]: "1",
			[CLAUDE_SCROLL_SPEED_ENV_VAR]:
				resolveEnvironmentValue(
					CLAUDE_SCROLL_SPEED_ENV_VAR,
					options.envOverrides,
					options.inheritedEnv ?? process.env,
				)?.trim() || DEFAULT_CLAUDE_FULLSCREEN_SCROLL_SPEED,
		};
	}
	return {
		// NO_FLICKER=0 is understood by every fullscreen-capable release (2.1.89+).
		// The stronger opt-out was added later and also overrides a persisted /tui
		// preference on current releases.
		[CLAUDE_FULLSCREEN_ENV_VAR]: "0",
		[CLAUDE_CLASSIC_RENDERER_ENV_VAR]: "1",
	};
}
