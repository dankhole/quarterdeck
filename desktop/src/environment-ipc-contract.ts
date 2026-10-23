import { z } from "zod";
import {
	desktopEnvironmentIntentSchema,
	desktopEnvironmentResponseSchema,
	desktopEnvironmentSnapshotSchema,
} from "../../src/shared/desktop-environment-contract.js";

const identitySchema = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/u);
export const desktopEnvironmentDocumentSchema = z.strictObject({
	runtimeGeneration: identitySchema,
	documentId: identitySchema,
});
export const desktopEnvironmentRequestSchema = desktopEnvironmentDocumentSchema.extend({
	intent: desktopEnvironmentIntentSchema,
});
export const desktopEnvironmentPublicationSchema = desktopEnvironmentDocumentSchema.extend({
	snapshot: desktopEnvironmentSnapshotSchema,
});
export const desktopEnvironmentReplySchema = desktopEnvironmentDocumentSchema.extend({
	response: desktopEnvironmentResponseSchema,
});
