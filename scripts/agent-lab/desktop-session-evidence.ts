import { readdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";

import { type RuntimeTaskSessionSummary, runtimeTaskSessionSummarySchema } from "../../src/core/api/task-session";

/** Read bounded synthetic state without opening a second runtime or exposing transcripts. */
export async function readDesktopTaskSession(
	stateHome: string,
	taskId: string,
): Promise<RuntimeTaskSessionSummary | null> {
	const projectsRoot = join(stateHome, "projects");
	for (const entry of await readdir(projectsRoot, { withFileTypes: true })) {
		if (!entry.isDirectory()) continue;
		let payload: unknown;
		try {
			const path = join(projectsRoot, entry.name, "sessions.json");
			if ((await stat(path)).size > 2 * 1024 * 1024)
				throw new Error("Synthetic session evidence exceeds its bound.");
			payload = JSON.parse(await readFile(path, "utf8")) as unknown;
		} catch (error) {
			if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") continue;
			throw error;
		}
		// The production persistence writer stores the task-keyed summaries directly,
		// not the enclosing ProjectStateSavePayload used by its in-memory API.
		if (typeof payload !== "object" || payload === null || !Object.hasOwn(payload, taskId)) continue;
		const parsed = runtimeTaskSessionSummarySchema.safeParse(Reflect.get(payload, taskId));
		if (parsed.success && parsed.data.taskId === taskId) return parsed.data;
	}
	return null;
}
