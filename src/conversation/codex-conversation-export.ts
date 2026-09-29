import { realpath } from "node:fs/promises";
import { resolve } from "node:path";
import packageJson from "../../package.json" with { type: "json" };
import {
	CodexAppServerClient,
	type SpawnCodexAppServerTransportOptions,
	spawnCodexAppServerTransport,
} from "../execution/codex-app-server-client";
import {
	type CodexHistoryTurn,
	codexAgentMessageSchema,
	codexUserMessageSchema,
} from "../execution/codex-history-protocol";

export class ConversationExportError extends Error {}

function formatCodexConversationTurn(turn: CodexHistoryTurn): string {
	const messages: string[] = [];
	for (const item of turn.items) {
		if (item.type === "userMessage") {
			const { content } = codexUserMessageSchema.parse(item);
			const text = content
				.map((part) => {
					switch (part.type) {
						case "text":
							return part.text;
						case "image":
							return "[Image]";
						case "audio":
							return "[Audio]";
						case "localImage":
							return `[Image: ${part.path}]`;
						case "localAudio":
							return `[Audio: ${part.path}]`;
						case "skill":
							return `[Skill: ${part.name}]`;
						case "mention":
							return `[${part.name}: ${part.path}]`;
						default:
							throw new Error("Unsupported user content");
					}
				})
				.join("\n");
			messages.push(`## You\n\n${text}`);
		} else if (item.type === "agentMessage" || item.type === "plan") {
			const { text } = codexAgentMessageSchema.parse(item);
			if (text) messages.push(`## Codex${item.type === "plan" ? " — Plan" : ""}\n\n${text}`);
		} else if (item.type === "contextCompaction") {
			messages.push("[Context compacted]");
		}
	}
	return messages.join("\n\n");
}

const MAX_EXPORT_BYTES = 8 * 1024 * 1024;
const MAX_HISTORY_PAGES = 1_000;
const READ_DEADLINE_MS = 30_000;

/** Reads persisted history only. Never resumes a thread, subscribes, or starts a turn. */
export async function exportCodexConversation(
	input: Pick<SpawnCodexAppServerTransportOptions, "binary" | "args" | "cwd" | "env"> & {
		threadId: string;
		codexHome: string;
	},
	dependencies: { spawnTransport?: typeof spawnCodexAppServerTransport; now?: () => number } = {},
): Promise<string> {
	const now = dependencies.now ?? Date.now;
	const deadline = now() + READ_DEADLINE_MS;
	const transport = (dependencies.spawnTransport ?? spawnCodexAppServerTransport)({
		binary: input.binary,
		args: ["app-server", ...input.args, "--stdio"],
		cwd: input.cwd,
		env: { ...input.env, CODEX_HOME: input.codexHome },
		maxMessageBytes: 16 * 1024 * 1024,
	});
	const client = new CodexAppServerClient(transport, { clientVersion: packageJson.version, requestTimeoutMs: 5_000 });
	try {
		const initialized = await client.initialize();
		const sameProfile =
			resolve(initialized.codexHome) === input.codexHome ||
			(await Promise.all([realpath(initialized.codexHome), realpath(input.codexHome)]).then(
				([actual, expected]) => actual === expected,
				() => false,
			));
		if (!sameProfile) {
			throw new ConversationExportError("Codex opened a different profile. Conversation was not copied.");
		}
		const { thread } = await client.readHistoryThread(input.threadId);
		if (thread.id !== input.threadId) {
			throw new ConversationExportError("Codex returned a different conversation. Conversation was not copied.");
		}
		const turns: string[] = [];
		const turnIds = new Set<string>();
		const cursors = new Set<string>();
		let cursor: string | null = null;
		let bytes = 0;
		for (let pageIndex = 0; pageIndex < MAX_HISTORY_PAGES; pageIndex++) {
			if (now() >= deadline)
				throw new ConversationExportError("Reading the full conversation took too long. Try again.");
			const page = await client.listHistoryTurns(input.threadId, cursor);
			for (const turn of page.data) {
				if (turnIds.has(turn.id))
					throw new ConversationExportError("Conversation history changed while copying. Try again.");
				turnIds.add(turn.id);
				const text = formatCodexConversationTurn(turn);
				bytes += Buffer.byteLength(text, "utf8") + 2;
				if (bytes > MAX_EXPORT_BYTES)
					throw new ConversationExportError("This conversation exceeds the 8 MB copy limit.");
				if (text) turns.push(text);
			}
			cursor = page.nextCursor;
			if (cursor === null) {
				if (!turns.length) throw new ConversationExportError("No saved messages are available to copy yet.");
				return `${turns.reverse().join("\n\n")}\n`;
			}
			if (cursors.has(cursor))
				throw new ConversationExportError("Codex could not read the full conversation. Try again.");
			cursors.add(cursor);
		}
		throw new ConversationExportError("This conversation exceeds the history copy limit.");
	} finally {
		await transport.stopAndReap(2_000);
	}
}
