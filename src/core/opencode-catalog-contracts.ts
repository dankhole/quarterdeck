import { z } from "zod";

/** Picker metadata parsed from `opencode models` (lines of the form `provider/model`). */
export const runtimeOpencodeModelSchema = z.object({
	/** `"provider/model"`, exactly as opencode's CLI and `--model` flag expect it. */
	id: z.string().min(1),
	providerId: z.string().min(1),
	modelId: z.string().min(1),
});

/** Picker metadata parsed from `opencode agent list`; subagent-only agents are filtered out before this schema is applied. */
export const runtimeOpencodeAgentSchema = z.object({
	name: z.string().min(1),
	mode: z.enum(["primary", "all"]),
});

export const runtimeOpencodeCatalogResponseSchema = z.object({
	models: z.array(runtimeOpencodeModelSchema),
	agents: z.array(runtimeOpencodeAgentSchema),
});

export type RuntimeOpencodeModel = z.infer<typeof runtimeOpencodeModelSchema>;
export type RuntimeOpencodeAgent = z.infer<typeof runtimeOpencodeAgentSchema>;
export type RuntimeOpencodeCatalogResponse = z.infer<typeof runtimeOpencodeCatalogResponseSchema>;
