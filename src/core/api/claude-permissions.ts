export const CLAUDE_LAUNCH_PERMISSION_MODES = [
	"inherit",
	"default",
	"acceptEdits",
	"plan",
	"auto",
	"dontAsk",
	"bypassPermissions",
] as const;

export type ClaudeLaunchPermissionMode = (typeof CLAUDE_LAUNCH_PERMISSION_MODES)[number];

export type ManagedClaudePermissionMode = Exclude<ClaudeLaunchPermissionMode, "inherit">;
