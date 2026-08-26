import type {
	RuntimeBoardData,
	RuntimeProjectBoardCommand,
	RuntimeProjectBoardCommandBatchEnvelope,
} from "../../src/core";

/** Builds an explicit command batch for integration tests that seed an empty project board. */
export function createBoardSeedCommandBatch(
	board: RuntimeBoardData,
	expectedRevision: number,
	commandId: string,
): RuntimeProjectBoardCommandBatchEnvelope {
	const commands: RuntimeProjectBoardCommand[] = [];
	for (const column of board.columns) {
		for (const card of [...column.cards].reverse()) {
			commands.push({
				kind: "create_task",
				columnId: column.id,
				taskId: card.id,
				title: card.title,
				prompt: card.prompt,
				images: card.images,
				baseRef: card.baseRef,
				agentId: card.agentId,
				useWorktree: card.useWorktree,
				branch: card.branch ?? undefined,
				pinned: card.pinned,
				createdAt: card.createdAt,
			});
			if (card.baseRefPinned || card.workingDirectory) {
				commands.push({
					kind: "patch_task",
					taskId: card.id,
					baseRefPinned: card.baseRefPinned ?? null,
					workingDirectory: card.workingDirectory ?? null,
					updatedAt: card.updatedAt,
				});
			}
		}
		for (const [targetIndex, card] of column.cards.entries()) {
			commands.push({ kind: "reorder_task", taskId: card.id, columnId: column.id, targetIndex });
		}
	}
	for (const dependency of board.dependencies) {
		commands.push({
			kind: "add_dependency",
			firstTaskId: dependency.fromTaskId,
			secondTaskId: dependency.toTaskId,
			dependencyId: dependency.id,
			createdAt: dependency.createdAt,
		});
	}
	if (commands.length === 0) {
		throw new Error("Board seed command batches require at least one task or dependency.");
	}
	return { commandId, expectedRevision, commands };
}
