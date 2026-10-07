import { z } from "zod";

export const QUARTERDECK_MANAGEMENT_PROTOCOL_VERSION = 1;
export const QUARTERDECK_DESKTOP_BRIDGE_VERSION = 1;
export const RUNTIME_MANAGEMENT_GENERATION_HEADER = "x-quarterdeck-runtime-generation";

export const runtimeProcessIdentitySchema = z.object({
	pid: z.number().int().positive().safe(),
	creationIdentity: z.string().min(1).max(512),
});
export type RuntimeProcessIdentity = z.infer<typeof runtimeProcessIdentitySchema>;

export const runtimeOwnershipClaimSchema = z
	.object({
		version: z.literal(1),
		generation: z.string().uuid(),
		canonicalStateHome: z.string().min(1),
		hostIdentity: z.string().min(1).max(512),
		custodyProtocolVersion: z.literal(1).optional(),
		bootIdentity: z.string().min(1).max(512).nullable().optional(),
		previousGeneration: z.string().uuid().nullable(),
		purpose: z.enum(["runtime", "maintenance"]),
		process: runtimeProcessIdentitySchema,
		claimedAt: z.string().datetime(),
	})
	.refine(
		(claim) =>
			(claim.custodyProtocolVersion === undefined && claim.bootIdentity === undefined) ||
			(claim.custodyProtocolVersion === 1 && claim.bootIdentity !== undefined),
	);
export type RuntimeOwnershipClaim = z.infer<typeof runtimeOwnershipClaimSchema>;

export const runtimeTransportCapabilitiesSchema = z.object({
	transportVersion: z.literal(1),
	browserHttp: z.boolean(),
	browserWebSocket: z.boolean(),
	desktopProxy: z.boolean(),
	desktopBridgeVersion: z.number().int().positive().nullable(),
});
export type RuntimeTransportCapabilities = z.infer<typeof runtimeTransportCapabilitiesSchema>;

export const runtimeOwnerDescriptorSchema = z.object({
	version: z.literal(1),
	generation: z.string().uuid(),
	canonicalStateHome: z.string().min(1),
	process: runtimeProcessIdentitySchema,
	status: z.enum(["starting", "ready", "stopping"]),
	endpoint: z.object({ host: z.string().min(1), port: z.number().int().min(1).max(65_535) }).nullable(),
	quarterdeckVersion: z.string().min(1),
	runtimeProtocolVersion: z.number().int().positive(),
	managementProtocolVersion: z.literal(QUARTERDECK_MANAGEMENT_PROTOCOL_VERSION),
	capabilities: runtimeTransportCapabilitiesSchema,
	startedAt: z.string().datetime(),
	readyAt: z.string().datetime().nullable(),
	managementToken: z.string().min(32).max(256),
});
export type RuntimeOwnerDescriptor = z.infer<typeof runtimeOwnerDescriptorSchema>;

export const publicRuntimeOwnerDescriptorSchema = runtimeOwnerDescriptorSchema.omit({ managementToken: true });
export type PublicRuntimeOwnerDescriptor = z.infer<typeof publicRuntimeOwnerDescriptorSchema>;

export const runtimeManagementHandshakeRequestSchema = z.object({
	generation: z.string().uuid(),
	canonicalStateHome: z.string().min(1),
	managementProtocolVersion: z.literal(QUARTERDECK_MANAGEMENT_PROTOCOL_VERSION),
	runtimeProtocolVersion: z.number().int().positive(),
});
export type RuntimeManagementHandshakeRequest = z.infer<typeof runtimeManagementHandshakeRequestSchema>;

export const runtimeManagementHandshakeResponseSchema = z.object({
	descriptor: publicRuntimeOwnerDescriptorSchema,
});
export type RuntimeManagementHandshakeResponse = z.infer<typeof runtimeManagementHandshakeResponseSchema>;

export const runtimeManagementProjectOpenRequestSchema = z.object({
	generation: z.string().uuid(),
	projectPath: z.string().min(1).max(32_768),
});
export type RuntimeManagementProjectOpenRequest = z.infer<typeof runtimeManagementProjectOpenRequestSchema>;

export const runtimeManagementProjectOpenResponseSchema = z.object({
	projectId: z.string().min(1),
});
export type RuntimeManagementProjectOpenResponse = z.infer<typeof runtimeManagementProjectOpenResponseSchema>;
