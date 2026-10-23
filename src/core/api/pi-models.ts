import { z } from "zod";

/** Metadata only: never send native model objects, credentials, headers, or endpoint URLs to clients. */
export const runtimePiModelSchema = z.object({
	provider: z
		.string()
		.min(1)
		.max(128)
		.regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/),
	id: z
		.string()
		.min(1)
		.max(256)
		.regex(/^[a-zA-Z0-9@~][a-zA-Z0-9._:/@~+-]*$/),
});
export type RuntimePiModel = z.infer<typeof runtimePiModelSchema>;
export const runtimePiModelsResponseSchema = z.object({ models: z.array(runtimePiModelSchema) });
export type RuntimePiModelsResponse = z.infer<typeof runtimePiModelsResponseSchema>;
