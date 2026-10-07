import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { open } from "node:fs/promises";

import { resolveFakeCodexHistoryPath } from "./fake-invocation-receipt";

const MAX_HISTORY_BYTES = 2 * 1024 * 1024;

/** Validate retained synthetic content without putting provider history into artifacts. */
export async function readDesktopFakeHistory(options: {
	environment: NodeJS.ProcessEnv;
	taskId: string;
	marker: string;
}): Promise<{ sha256: string; bytes: number }> {
	const sessionId = `agent-lab-${options.taskId}`;
	const path = await resolveFakeCodexHistoryPath(options.environment, sessionId);
	const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
	let contents: Buffer;
	try {
		const metadata = await file.stat();
		if (!metadata.isFile() || metadata.size === 0 || metadata.size > MAX_HISTORY_BYTES)
			throw new Error("Synthetic recovery history exceeds its bound.");
		const buffer = Buffer.alloc(MAX_HISTORY_BYTES + 1);
		const { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
		if (bytesRead !== metadata.size || bytesRead > MAX_HISTORY_BYTES)
			throw new Error("Synthetic recovery history changed during its bounded read.");
		contents = buffer.subarray(0, bytesRead);
	} finally {
		await file.close();
	}
	let exactSession = false;
	let seeded = false;
	for (const line of contents.toString("utf8").split("\n").filter(Boolean)) {
		const entry: unknown = JSON.parse(line);
		if (typeof entry !== "object" || entry === null || !("payload" in entry)) continue;
		const payload = entry.payload;
		if (typeof payload !== "object" || payload === null || !("type" in entry)) continue;
		if (entry.type === "session_meta" && "id" in payload) exactSession ||= payload.id === sessionId;
		if (
			entry.type === "response_item" &&
			"role" in payload &&
			payload.role === "assistant" &&
			"content" in payload &&
			Array.isArray(payload.content)
		)
			seeded ||= payload.content.some(
				(part: unknown) =>
					typeof part === "object" &&
					part !== null &&
					"type" in part &&
					part.type === "output_text" &&
					"text" in part &&
					part.text === options.marker,
			);
	}
	if (!exactSession || !seeded) throw new Error("Synthetic recovery history lacks its exact seeded conversation.");
	return { sha256: createHash("sha256").update(contents).digest("hex"), bytes: contents.length };
}
