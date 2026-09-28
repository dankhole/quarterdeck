import { z } from "zod";

const argumentSchema = z
	.string()
	.max(16_384)
	.refine((value) => !value.includes("\0"), "NUL is not allowed.");
export const lspServerConfigSchema = z.object({
	id: z
		.string()
		.trim()
		.min(1)
		.max(80)
		.regex(/^[a-zA-Z0-9_-]+$/),
	label: z.string().trim().min(1).max(120),
	enabled: z.boolean(),
	command: argumentSchema.pipe(z.string().trim().min(1)),
	args: z.array(argumentSchema).max(100),
	extensions: z
		.array(z.string().regex(/^\.[a-zA-Z0-9]+$/))
		.min(1)
		.max(100),
	rootMarkers: z
		.array(
			z
				.string()
				.min(1)
				.max(128)
				.regex(/^[^/\\\0]+$/)
				.refine((v) => v !== "." && v !== ".."),
		)
		.max(30),
	initializationOptions: z.json().optional(),
	env: z.record(z.string().regex(/^[a-zA-Z_][a-zA-Z0-9_]*$/), argumentSchema).optional(),
});
export type LspServerConfig = z.infer<typeof lspServerConfigSchema>;
export const lspServersSchema = z
	.array(lspServerConfigSchema)
	.max(20)
	.refine(
		(servers) => new Set(servers.map((server) => server.id)).size === servers.length,
		"Language server IDs must be unique.",
	);

export const codeNavigationPositionSchema = z.object({
	line: z.number().int().min(0),
	character: z.number().int().min(0),
});
export const codeNavigationRangeSchema = z.object({
	start: codeNavigationPositionSchema,
	end: codeNavigationPositionSchema,
});
export const codeNavigationScopeSchema = z.object({
	path: z.string().min(1).max(4096),
	taskId: z.string().nullable().optional(),
	baseRef: z.string().optional(),
	ref: z.string().optional(),
});
export const codeNavigationRequestSchema = codeNavigationScopeSchema.extend({
	position: codeNavigationPositionSchema,
	documentVersion: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
	content: z.string().max(5_242_880),
	includeDeclaration: z.boolean().optional(),
});
export const codeNavigationLocationSchema = z.object({ path: z.string(), range: codeNavigationRangeSchema });
const failureSchema = z.object({
	status: z.enum(["unavailable", "error"]),
	message: z.string(),
	documentVersion: z.number(),
});
export const codeNavigationResponseSchema = z.union([
	z.object({
		status: z.literal("ok"),
		locations: z.array(codeNavigationLocationSchema),
		documentVersion: z.number(),
		truncated: z.boolean(),
	}),
	failureSchema,
]);
export const codeNavigationHoverResponseSchema = z.union([
	z.object({
		status: z.literal("ok"),
		contents: z.string(),
		range: codeNavigationRangeSchema.optional(),
		documentVersion: z.number(),
	}),
	failureSchema,
]);
export const codeNavigationStatusSchema = z.object({
	status: z.enum(["ready", "disabled", "unavailable"]),
	message: z.string(),
	serverId: z.string().optional(),
	command: z.string().optional(),
});
export type CodeNavigationScope = z.infer<typeof codeNavigationScopeSchema>;
export type CodeNavigationRequest = z.infer<typeof codeNavigationRequestSchema>;
export type CodeNavigationResponse = z.infer<typeof codeNavigationResponseSchema>;
export type CodeNavigationHoverResponse = z.infer<typeof codeNavigationHoverResponseSchema>;
export type CodeNavigationLocation = z.infer<typeof codeNavigationLocationSchema>;
export type CodeNavigationStatus = z.infer<typeof codeNavigationStatusSchema>;
