import { z } from "zod";
import { promptShortcutSchema, runtimeAgentIdSchema, runtimeProjectShortcutSchema } from "./shared.js";

export const runtimeAgentInstallStatusSchema = z.enum(["installed", "upgrade_required", "missing"]);
export type RuntimeAgentInstallStatus = z.infer<typeof runtimeAgentInstallStatusSchema>;
export const runtimeOpenTargetPlatformSchema = z.enum(["mac", "windows", "linux", "other"]);
export type RuntimeOpenTargetPlatform = z.infer<typeof runtimeOpenTargetPlatformSchema>;

export const runtimeAgentDefinitionSchema = z.object({
	id: runtimeAgentIdSchema,
	label: z.string(),
	binary: z.string(),
	command: z.string(),
	defaultArgs: z.array(z.string()),
	status: runtimeAgentInstallStatusSchema,
	statusMessage: z.string().nullable(),
	installed: z.boolean(),
	configured: z.boolean(),
});
export type RuntimeAgentDefinition = z.infer<typeof runtimeAgentDefinitionSchema>;

export const runtimeConfigResponseSchema = z.object({
	selectedAgentId: runtimeAgentIdSchema,
	runtimePlatform: runtimeOpenTargetPlatformSchema,
	selectedShortcutLabel: z.string().nullable(),
	debugModeEnabled: z.boolean().optional(),
	effectiveCommand: z.string().nullable(),
	globalConfigPath: z.string(),
	projectConfigPath: z.string().nullable(),
	readyForReviewNotificationsEnabled: z.boolean(),
	shellAutoRestartEnabled: z.boolean(),
	showTrashWorktreeNotice: z.boolean(),
	uncommittedChangesOnCardsEnabled: z.boolean(),
	unmergedChangesIndicatorEnabled: z.boolean(),
	behindBaseIndicatorEnabled: z.boolean(),
	skipTaskCheckoutConfirmation: z.boolean(),
	skipHomeCheckoutConfirmation: z.boolean(),
	skipCherryPickConfirmation: z.boolean(),
	audibleNotificationsEnabled: z.boolean(),
	audibleNotificationVolume: z.number().min(0).max(1),
	audibleNotificationEvents: z.object({
		permission: z.boolean(),
		review: z.boolean(),
		failure: z.boolean(),
	}),
	audibleNotificationsOnlyWhenHidden: z.boolean(),
	audibleNotificationSuppressCurrentProject: z.object({
		permission: z.boolean(),
		review: z.boolean(),
		failure: z.boolean(),
	}),
	commitPromptTemplate: z.string(),
	openPrPromptTemplate: z.string(),
	worktreeSystemPromptTemplate: z.string(),
	commitPromptTemplateDefault: z.string(),
	openPrPromptTemplateDefault: z.string(),
	worktreeSystemPromptTemplateDefault: z.string(),
	detectedCommands: z.array(z.string()),
	agents: z.array(runtimeAgentDefinitionSchema),
	shortcuts: z.array(runtimeProjectShortcutSchema),
	pinnedBranches: z.array(z.string()),
	promptShortcuts: z.array(promptShortcutSchema),
	hiddenDefaultPromptShortcuts: z.array(z.string()),
	showSummaryOnCards: z.boolean(),
	autoGenerateSummary: z.boolean(),
	summaryStaleAfterSeconds: z.number(),
	statuslineEnabled: z.boolean(),
	terminalFontWeight: z.number(),
	logLevel: z.enum(["debug", "info", "warn", "error"]),
	defaultBaseRef: z.string(),
	backupIntervalMinutes: z.number(),
	agentTerminalRowMultiplier: z.number(),
	llmConfigured: z.boolean(),
});
export type RuntimeConfigResponse = z.infer<typeof runtimeConfigResponseSchema>;

export const runtimeConfigSaveRequestSchema = z.object({
	selectedAgentId: runtimeAgentIdSchema.optional(),
	selectedShortcutLabel: z.string().nullable().optional(),
	shortcuts: z.array(runtimeProjectShortcutSchema).optional(),
	pinnedBranches: z.array(z.string()).optional(),
	promptShortcuts: z.array(promptShortcutSchema).optional(),
	hiddenDefaultPromptShortcuts: z.array(z.string()).optional(),
	readyForReviewNotificationsEnabled: z.boolean().optional(),
	shellAutoRestartEnabled: z.boolean().optional(),
	showSummaryOnCards: z.boolean().optional(),
	autoGenerateSummary: z.boolean().optional(),
	summaryStaleAfterSeconds: z.number().min(5).optional(),
	showTrashWorktreeNotice: z.boolean().optional(),
	uncommittedChangesOnCardsEnabled: z.boolean().optional(),
	unmergedChangesIndicatorEnabled: z.boolean().optional(),
	behindBaseIndicatorEnabled: z.boolean().optional(),
	skipTaskCheckoutConfirmation: z.boolean().optional(),
	skipHomeCheckoutConfirmation: z.boolean().optional(),
	skipCherryPickConfirmation: z.boolean().optional(),
	commitPromptTemplate: z.string().optional(),
	openPrPromptTemplate: z.string().optional(),
	worktreeSystemPromptTemplate: z.string().optional(),
	audibleNotificationsEnabled: z.boolean().optional(),
	audibleNotificationVolume: z.number().min(0).max(1).optional(),
	audibleNotificationEvents: z
		.object({
			permission: z.boolean(),
			review: z.boolean(),
			failure: z.boolean(),
		})
		.optional(),
	audibleNotificationsOnlyWhenHidden: z.boolean().optional(),
	audibleNotificationSuppressCurrentProject: z
		.object({
			permission: z.boolean(),
			review: z.boolean(),
			failure: z.boolean(),
		})
		.optional(),
	statuslineEnabled: z.boolean().optional(),
	terminalFontWeight: z.number().min(100).max(900).optional(),
	logLevel: z.enum(["debug", "info", "warn", "error"]).optional(),
	defaultBaseRef: z.string().optional(),
	backupIntervalMinutes: z.number().min(0).optional(),
	agentTerminalRowMultiplier: z.number().min(1).max(20).optional(),
});
export type RuntimeConfigSaveRequest = z.infer<typeof runtimeConfigSaveRequestSchema>;
