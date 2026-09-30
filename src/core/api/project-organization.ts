import { z } from "zod";

export const projectGroupNameSchema = z
	.string()
	.trim()
	.min(1, "Enter a group name.")
	.max(60, "Use 60 characters or fewer.")
	.refine((name) => name.toLowerCase() !== "ungrouped", "Choose a name other than Ungrouped.");
export const projectGroupSchema = z.object({ id: z.string().min(1), name: projectGroupNameSchema });
export const projectOrganizationSchema = z.object({
	id: z.string().min(1),
	revision: z.number().int().nonnegative(),
	groups: z.array(projectGroupSchema),
	membership: z.record(z.string(), z.string()),
	projectOrder: z.array(z.string()),
});
export type ProjectGroup = z.infer<typeof projectGroupSchema>;
export type ProjectOrganization = z.infer<typeof projectOrganizationSchema>;

export const projectOrganizationCommandSchema = z.discriminatedUnion("type", [
	z.object({
		type: z.literal("create"),
		id: z.string().uuid(),
		name: projectGroupNameSchema,
		projectIds: z.array(z.string()),
	}),
	z.object({ type: z.literal("rename"), groupId: z.string(), name: projectGroupNameSchema }),
	z.object({ type: z.literal("remove"), groupId: z.string() }),
	z.object({
		type: z.literal("move"),
		projectIds: z.array(z.string()).min(1),
		groupId: z.string().nullable(),
		beforeProjectId: z.string().nullable(),
	}),
	z.object({ type: z.literal("reorder_group"), groupId: z.string(), beforeGroupId: z.string().nullable() }),
]);
export type ProjectOrganizationCommand = z.infer<typeof projectOrganizationCommandSchema>;
export const projectOrganizationRequestSchema = z.object({
	expectedRevision: z.number().int().nonnegative(),
	command: projectOrganizationCommandSchema,
});
export type ProjectOrganizationRequest = z.infer<typeof projectOrganizationRequestSchema>;
export const projectOrganizationResponseSchema = z.discriminatedUnion("ok", [
	z.object({ ok: z.literal(true), organization: projectOrganizationSchema }),
	z.object({ ok: z.literal(false), error: z.string(), organization: projectOrganizationSchema.nullable() }),
]);
export type ProjectOrganizationResponse = z.infer<typeof projectOrganizationResponseSchema>;
