import { z } from "zod";
import { runtimeOpenTargetIdSchema } from "./host-integrations.js";
import { runtimeAgentIdSchema } from "./shared.js";

export const MAX_UI_PREFERENCES_BYTES = 64 * 1_024;

const ratio = z.number().min(0).max(1);
const pixels = z.number().min(0).max(100_000);
// Keys deliberately match legacy browser storage names. This is an allowlist,
// never a transport for arbitrary browser storage, drafts, or navigation.
export const runtimeUiPreferenceValuesSchema = z.strictObject({
	"quarterdeck.task-create-primary-start-action": z.enum(["start", "start_and_open"]).nullable().optional(),
	"quarterdeck.task-create-last-agent-id": runtimeAgentIdSchema.nullable().optional(),
	"quarterdeck.bottom-terminal-pane-height": pixels.nullable().optional(),
	"quarterdeck.detail-last-sidebar-tab": z.enum(["projects", "task_column", "commit"]).nullable().optional(),
	"quarterdeck.detail-side-panel-ratio": ratio.nullable().optional(),
	"quarterdeck.detail-diff-file-tree-panel-ratio": ratio.nullable().optional(),
	"quarterdeck.detail-expanded-diff-file-tree-panel-ratio": ratio.nullable().optional(),
	"quarterdeck.detail-file-browser-tree-panel-ratio": ratio.nullable().optional(),
	"quarterdeck.git-history-refs-panel-width": pixels.nullable().optional(),
	"quarterdeck.git-history-commits-panel-width": pixels.nullable().optional(),
	"quarterdeck.git-diff-file-tree-panel-ratio": ratio.nullable().optional(),
	"quarterdeck.commit-panel-controls-height": pixels.nullable().optional(),
	"quarterdeck.onboarding.dialog.shown": z.boolean().nullable().optional(),
	"quarterdeck.onboarding.tips.dismissed": z.boolean().nullable().optional(),
	"quarterdeck.sidebar-help-expanded": z.boolean().nullable().optional(),
	"quarterdeck.preferred-open-target": runtimeOpenTargetIdSchema.nullable().optional(),
	"quarterdeck.prompt-shortcut-last-label": z.string().max(500).nullable().optional(),
	"quarterdeck.git-view-file-tree-ratio": ratio.nullable().optional(),
	"quarterdeck.diagnostics-panel-width": pixels.nullable().optional(),
	"quarterdeck.file-browser-word-wrap": z.boolean().nullable().optional(),
	"quarterdeck.file-browser-markdown-preview": z.boolean().nullable().optional(),
	"quarterdeck.compare-include-uncommitted": z.boolean().nullable().optional(),
	"quarterdeck.compare-three-dot-diff": z.boolean().nullable().optional(),
});
export type RuntimeUiPreferenceValues = z.infer<typeof runtimeUiPreferenceValuesSchema>;
export type RuntimeUiPreferenceKey = keyof RuntimeUiPreferenceValues;
export const RUNTIME_UI_PREFERENCE_KEYS = Object.keys(
	runtimeUiPreferenceValuesSchema.shape,
) as RuntimeUiPreferenceKey[];

export const runtimeCollapsedProjectGroupsSchema = z
	.record(
		z.string().regex(/^[A-Za-z0-9_-]{1,128}$/),
		z
			.array(z.string().regex(/^[A-Za-z0-9_-]{1,128}$/))
			.max(1_000)
			.nullable(),
	)
	.refine((groups) => Object.keys(groups).length <= 32, "Too many organization preferences.");

export const runtimeUiPreferencesSchema = z
	.strictObject({
		revision: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
		values: runtimeUiPreferenceValuesSchema,
		collapsedProjectGroups: runtimeCollapsedProjectGroupsSchema,
	})
	.refine(
		(preferences) => new TextEncoder().encode(JSON.stringify(preferences)).byteLength <= MAX_UI_PREFERENCES_BYTES,
		"UI preferences exceed the storage limit.",
	);
export type RuntimeUiPreferences = z.infer<typeof runtimeUiPreferencesSchema>;

export const runtimeUiPreferencesPatchSchema = z
	.strictObject({
		mode: z.enum(["patch", "seed"]),
		values: runtimeUiPreferenceValuesSchema,
		collapsedProjectGroups: runtimeCollapsedProjectGroupsSchema.optional(),
	})
	.refine(
		(patch) => new TextEncoder().encode(JSON.stringify(patch)).byteLength <= MAX_UI_PREFERENCES_BYTES,
		"UI preference patch exceeds the storage limit.",
	);
export type RuntimeUiPreferencesPatch = z.infer<typeof runtimeUiPreferencesPatchSchema>;

export const runtimeStateStreamUiPreferencesMessageSchema = z.strictObject({
	type: z.literal("ui_preferences"),
	preferences: runtimeUiPreferencesSchema,
});
export const runtimeStateStreamConfigChangedMessageSchema = z.strictObject({
	type: z.literal("config_changed"),
	/** Global fields may change in either a global or a project settings save. */
	projectId: z.string().nullable(),
});
