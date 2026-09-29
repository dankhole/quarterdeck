import { z } from "zod";

export const runtimeTaskConversationRequestSchema = z
	.object({
		taskId: z.string().min(1).max(512),
		sessionInstanceId: z.string().min(1).max(512),
	})
	.strict();

export const runtimeTaskConversationResponseSchema = z.discriminatedUnion("ok", [
	z.object({ ok: z.literal(true), text: z.string() }),
	z.object({ ok: z.literal(false), error: z.string() }),
]);

export type RuntimeTaskConversationRequest = z.infer<typeof runtimeTaskConversationRequestSchema>;
export type RuntimeTaskConversationResponse = z.infer<typeof runtimeTaskConversationResponseSchema>;
