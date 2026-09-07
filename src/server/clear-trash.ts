import { createHash } from "node:crypto";
import type {
	RuntimeClearTrashRequest,
	RuntimeClearTrashResult,
	RuntimeTaskLifecycleCommand,
	RuntimeTaskLifecycleResult,
} from "../core";
import { findCardInBoard } from "../core";
import type { ProjectBoardCommandScope } from "../state";

const CLEAR_TRASH_CONCURRENCY = 4;

/** Captures the project and exact identities once; every effect still belongs to task lifecycle. */
export async function clearTrashTasks(
	scope: ProjectBoardCommandScope,
	request: RuntimeClearTrashRequest,
	execute: (
		scope: ProjectBoardCommandScope,
		command: RuntimeTaskLifecycleCommand,
	) => Promise<RuntimeTaskLifecycleResult>,
): Promise<RuntimeClearTrashResult["results"]> {
	const results: RuntimeClearTrashResult["results"] = new Array(request.tasks.length);
	let next = 0;
	await Promise.all(
		Array.from({ length: Math.min(CLEAR_TRASH_CONCURRENCY, request.tasks.length) }, async () => {
			while (next < request.tasks.length) {
				const index = next++;
				const task = request.tasks[index];
				if (!task) continue;
				const operationId = `clear-trash:${createHash("sha256")
					.update(JSON.stringify([request.operationId, task]))
					.digest("hex")}`;
				try {
					const result = await execute(scope, {
						kind: "delete",
						...task,
						operationId,
						expectedRevision: request.expectedRevision,
					});
					const unconfirmed =
						result.operation.outcomeCode === "stale_task" && !findCardInBoard(result.state.board, task.taskId);
					results[index] = {
						...task,
						ok: result.ok,
						outcomeCode: unconfirmed ? "unconfirmed" : (result.operation.outcomeCode ?? "internal_error"),
						error: unconfirmed
							? "This task is no longer present, but its earlier deletion could not be confirmed."
							: result.error,
					};
				} catch {
					results[index] = {
						...task,
						ok: false,
						outcomeCode: "internal_error",
						error: "Could not confirm this task was deleted. Try clearing Trash again.",
					};
				}
			}
		}),
	);
	return results;
}
