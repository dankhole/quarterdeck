import type { RuntimeClearTrashRequest, RuntimeClearTrashResult } from "@/runtime/types";

export async function sendClearTrashRequest(
	request: RuntimeClearTrashRequest,
	send: (request: RuntimeClearTrashRequest) => Promise<RuntimeClearTrashResult>,
): Promise<RuntimeClearTrashResult> {
	try {
		return await send(request);
	} catch {
		// Replay the same child identities after an ambiguous transport failure.
		return await send(request);
	}
}

export function summarizeClearTrash(result: RuntimeClearTrashResult): { message: string; failed: number } {
	const deleted = result.results.filter((task) => task.ok).length;
	const failed = result.results.length - deleted;

	return {
		failed,
		message:
			failed > 0
				? `Deleted ${deleted} task${deleted === 1 ? "" : "s"}. Could not confirm deletion of ${failed} task${failed === 1 ? "" : "s"}; check Trash before retrying.`
				: `Deleted ${deleted} task${deleted === 1 ? "" : "s"} from Trash.`,
	};
}
