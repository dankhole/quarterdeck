import { z } from "zod";

const notificationEventPreferencesSchema = z.strictObject({
	permission: z.boolean(),
	review: z.boolean(),
	failure: z.boolean(),
});
export const runtimeNotificationPreferencesSchema = z.strictObject({
	enabled: z.boolean(),
	volume: z.number().min(0).max(1),
	events: notificationEventPreferencesSchema,
	onlyWhenHidden: z.boolean(),
	suppressCurrentProject: notificationEventPreferencesSchema,
});
export type RuntimeNotificationPreferences = z.infer<typeof runtimeNotificationPreferencesSchema>;

/** Presentation ownership is transient and has no authority over task lifecycle. */
export const runtimeNotificationPresentationStateSchema = z.strictObject({
	owner: z.enum(["desktop", "browser"]),
	epoch: z.string().uuid().nullable(),
	runtimeGeneration: z.string().uuid(),
});
export type RuntimeNotificationPresentationState = z.infer<typeof runtimeNotificationPresentationStateSchema>;

export const runtimeNotificationPresentationRenewSchema = z.strictObject({
	type: z.literal("notification_presentation_renew"),
	runtimeGeneration: z.string().uuid(),
	epoch: z.string().uuid(),
});
export type RuntimeNotificationPresentationRenew = z.infer<typeof runtimeNotificationPresentationRenewSchema>;

export const runtimeStateStreamNotificationPresentationMessageSchema = z.strictObject({
	type: z.literal("notification_presentation"),
	state: runtimeNotificationPresentationStateSchema,
	/** Sent only to the owning desktop subscription; ordinary broadcasts omit it. */
	granted: z.boolean().optional(),
});
export type RuntimeStateStreamNotificationPresentationMessage = z.infer<
	typeof runtimeStateStreamNotificationPresentationMessageSchema
>;

export const runtimeStateStreamNotificationPreferencesMessageSchema = z.strictObject({
	type: z.literal("notification_preferences"),
	preferences: runtimeNotificationPreferencesSchema,
});
export type RuntimeStateStreamNotificationPreferencesMessage = z.infer<
	typeof runtimeStateStreamNotificationPreferencesMessageSchema
>;
