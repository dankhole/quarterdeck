// Single source of truth for all runtime configuration default values.
// Both the Node.js runtime and the browser UI import from this file
// (the frontend via the @runtime-config-defaults path alias).
//
// Simple field defaults (booleans, numbers) are defined in global-config-fields.ts.
// This file re-exports those defaults and adds complex constants (prompt templates,
// shortcut arrays) that don't fit the field registry pattern.
import type { PromptShortcut, RuntimeAgentId } from "../core/api-contract";
import {
	DEFAULT_COMMIT_PROMPT_TEMPLATE,
	DEFAULT_OPEN_PR_PROMPT_TEMPLATE,
	DEFAULT_SQUASH_MERGE_PROMPT_TEMPLATE,
	DEFAULT_WORKTREE_SYSTEM_PROMPT_TEMPLATE,
} from "../prompts/prompt-templates";
import { getGlobalConfigDefaults } from "./global-config-fields";

export type { LogLevel } from "./global-config-fields";

export interface AudibleNotificationEvents {
	permission: boolean;
	review: boolean;
	failure: boolean;
}

export interface AudibleNotificationSuppressCurrentProject {
	permission: boolean;
	review: boolean;
	failure: boolean;
}

export {
	DEFAULT_COMMIT_PROMPT_TEMPLATE,
	DEFAULT_OPEN_PR_PROMPT_TEMPLATE,
	DEFAULT_SQUASH_MERGE_PROMPT_TEMPLATE,
	DEFAULT_WORKTREE_SYSTEM_PROMPT_TEMPLATE,
};

export const DEFAULT_AGENT_ID: RuntimeAgentId = "claude";

export const DEFAULT_AUDIBLE_NOTIFICATION_EVENTS: AudibleNotificationEvents = {
	permission: true,
	review: true,
	failure: true,
};

export const DEFAULT_AUDIBLE_NOTIFICATION_SUPPRESS_CURRENT_PROJECT: AudibleNotificationSuppressCurrentProject = {
	permission: false,
	review: false,
	failure: false,
};

export const DEFAULT_PROMPT_SHORTCUTS: readonly PromptShortcut[] = [
	{
		label: "Commit",
		prompt: DEFAULT_COMMIT_PROMPT_TEMPLATE,
	},
	{
		label: "Squash Merge",
		prompt: DEFAULT_SQUASH_MERGE_PROMPT_TEMPLATE,
	},
];

/** Convenience object for frontend ?? fallback usage. */
export const CONFIG_DEFAULTS = {
	...getGlobalConfigDefaults(),
	selectedAgentId: DEFAULT_AGENT_ID,
	audibleNotificationEvents: { ...DEFAULT_AUDIBLE_NOTIFICATION_EVENTS },
	audibleNotificationSuppressCurrentProject: { ...DEFAULT_AUDIBLE_NOTIFICATION_SUPPRESS_CURRENT_PROJECT },
};
