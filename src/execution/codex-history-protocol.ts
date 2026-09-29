import { z } from "zod";

// Read-only projection of the installed Codex 0.157.1 generated app-server schema.
// Independent of the older, exact-version structured execution compatibility tuple.
export const codexHistoryThreadSchema = z.object({
	thread: z.object({ id: z.string() }),
});

export const codexHistoryPageSchema = z.object({
	data: z.array(
		z.object({
			id: z.string(),
			itemsView: z.literal("full").default("full"),
			items: z.array(z.object({ type: z.string(), id: z.string() }).passthrough()),
		}),
	),
	nextCursor: z.string().nullable().default(null),
});

const userContentSchema = z.discriminatedUnion("type", [
	z.object({ type: z.literal("text"), text: z.string() }),
	z.object({ type: z.literal("image") }),
	z.object({ type: z.literal("localImage"), path: z.string() }),
	z.object({ type: z.literal("audio") }),
	z.object({ type: z.literal("localAudio"), path: z.string() }),
	z.object({ type: z.literal("skill"), name: z.string(), path: z.string() }),
	z.object({ type: z.literal("mention"), name: z.string(), path: z.string() }),
]);

export const codexUserMessageSchema = z.object({ content: z.array(userContentSchema) });
export const codexAgentMessageSchema = z.object({ text: z.string() });
export type CodexHistoryTurn = z.infer<typeof codexHistoryPageSchema>["data"][number];
