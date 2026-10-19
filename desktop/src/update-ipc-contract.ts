import { z } from "zod";
import { desktopUpdateIntentSchema, desktopUpdateSnapshotSchema } from "../../src/shared/desktop-update-contract.js";

const identitySchema = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/u);
export const desktopUpdateDocumentSchema = z.strictObject({
	runtimeGeneration: identitySchema,
	documentId: identitySchema,
});
export const desktopUpdateSubscriptionSchema = desktopUpdateDocumentSchema.extend({ subscribed: z.boolean() });
export const desktopUpdateRequestSchema = desktopUpdateDocumentSchema.extend({ intent: desktopUpdateIntentSchema });
export const desktopUpdatePublicationSchema = desktopUpdateDocumentSchema.extend({
	revision: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
	snapshot: desktopUpdateSnapshotSchema,
});
