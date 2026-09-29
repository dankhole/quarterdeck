import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { z } from "zod";

const requestSchema = z.object({
	threadId: z.string().regex(/^agent-lab-[a-zA-Z0-9-]+$/),
	cursor: z.string().nullish(),
});
const messageSchema = z.object({
	type: z.literal("response_item"),
	payload: z.object({
		type: z.literal("message"),
		role: z.enum(["user", "assistant"]),
		content: z.array(z.object({ text: z.string() })),
	}),
});

/** Exposes only synthetic lab history through the same paginated read contract as Codex. */
export async function readFakeCodexHistory(
	method: "thread/read" | "thread/turns/list",
	params: unknown,
): Promise<unknown> {
	const { threadId, cursor } = requestSchema.parse(params);
	const path = join(process.env.CODEX_HOME || join(homedir(), ".codex"), "sessions", `rollout-${threadId}.jsonl`);
	const contents = await readFile(path, "utf8");
	if (method === "thread/read") return { thread: { id: threadId, sessionId: threadId } };
	const turns = contents
		.split("\n")
		.filter(Boolean)
		.flatMap((line, index) => {
			const parsed = messageSchema.safeParse(JSON.parse(line));
			if (!parsed.success) return [];
			const { role, content } = parsed.data.payload;
			const text = content.map((part) => part.text).join("\n");
			return [
				{
					id: `turn-${index}`,
					itemsView: "full",
					items: [
						role === "user"
							? { id: `item-${index}`, type: "userMessage", content: [{ type: "text", text }] }
							: { id: `item-${index}`, type: "agentMessage", text },
					],
				},
			];
		})
		.reverse();
	const offset = cursor ? Number(cursor) : 0;
	const data = turns.slice(offset, offset + 10);
	return { data, nextCursor: offset + 10 < turns.length ? String(offset + 10) : null };
}
