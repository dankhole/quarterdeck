import { z } from "zod";

/** Picker metadata returned by the installed Codex app-server model/list API. */
export const runtimeCodexModelSchema = z.object({
	id: z.string().min(1),
	model: z.string().min(1),
	displayName: z.string(),
	supportedReasoningEfforts: z.array(
		z.object({
			reasoningEffort: z.string().min(1),
			description: z.string(),
		}),
	),
	defaultReasoningEffort: z.string().min(1),
	isDefault: z.boolean(),
});

export const runtimeCodexModelsResponseSchema = z.object({ models: z.array(runtimeCodexModelSchema) });
export type RuntimeCodexModel = z.infer<typeof runtimeCodexModelSchema>;
export type RuntimeCodexModelsResponse = z.infer<typeof runtimeCodexModelsResponseSchema>;
