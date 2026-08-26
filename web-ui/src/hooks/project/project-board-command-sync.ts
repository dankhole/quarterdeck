import { applyProjectBoardCommands } from "@runtime-board-commands";
import type { RuntimeProjectBoardCommand } from "@runtime-contract";

import type { BoardCard, BoardColumnId, BoardData, BoardDependency, TaskImage } from "@/types";

interface CardLocation {
	card: BoardCard;
	columnId: BoardColumnId;
	index: number;
}

function collectCardLocations(board: BoardData): Map<string, CardLocation> {
	const locations = new Map<string, CardLocation>();
	for (const column of board.columns) {
		for (const [index, card] of column.cards.entries()) {
			locations.set(card.id, { card, columnId: column.id, index });
		}
	}
	return locations;
}

function areImagesEqual(first: TaskImage[] | undefined, second: TaskImage[] | undefined): boolean {
	const left = first?.length ? first : undefined;
	const right = second?.length ? second : undefined;
	if (left === right) {
		return true;
	}
	if (!left || !right || left.length !== right.length) {
		return false;
	}
	return left.every((image, index) => {
		const candidate = right[index];
		return (
			candidate !== undefined &&
			image.id === candidate.id &&
			image.data === candidate.data &&
			image.mimeType === candidate.mimeType &&
			image.name === candidate.name
		);
	});
}

function hasEditableTaskChange(before: BoardCard, after: BoardCard): boolean {
	return (
		before.title !== after.title ||
		before.prompt !== after.prompt ||
		!areImagesEqual(before.images, after.images) ||
		before.baseRef !== after.baseRef ||
		before.useWorktree !== after.useWorktree ||
		Boolean(before.pinned) !== Boolean(after.pinned)
	);
}

function hasTaskPatchChange(before: BoardCard, after: BoardCard): boolean {
	return (
		before.agentId !== after.agentId ||
		Boolean(before.baseRefPinned) !== Boolean(after.baseRefPinned) ||
		(before.workingDirectory ?? null) !== (after.workingDirectory ?? null) ||
		(before.branch ?? null) !== (after.branch ?? null)
	);
}

function dependencyById(dependencies: readonly BoardDependency[]): Map<string, BoardDependency> {
	return new Map(dependencies.map((dependency) => [dependency.id, dependency]));
}

/**
 * Converts one existing optimistic board transition into the explicit command
 * batch the runtime will validate and persist atomically.
 */
export function deriveProjectBoardCommands(before: BoardData, after: BoardData): RuntimeProjectBoardCommand[] {
	if (before === after) {
		return [];
	}
	const commands: RuntimeProjectBoardCommand[] = [];
	const beforeCards = collectCardLocations(before);
	const afterCards = collectCardLocations(after);
	const deletedTaskIds = Array.from(beforeCards.keys()).filter((taskId) => !afterCards.has(taskId));
	if (deletedTaskIds.length > 0) {
		commands.push({ kind: "delete_tasks", taskIds: deletedTaskIds });
	}

	for (const column of after.columns) {
		for (const card of [...column.cards].reverse()) {
			if (beforeCards.has(card.id)) {
				continue;
			}
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
	}

	for (const [taskId, nextLocation] of afterCards) {
		const previousLocation = beforeCards.get(taskId);
		if (!previousLocation) {
			continue;
		}
		if (hasEditableTaskChange(previousLocation.card, nextLocation.card)) {
			commands.push({
				kind: "update_task",
				taskId,
				title: nextLocation.card.title,
				prompt: nextLocation.card.prompt,
				images: nextLocation.card.images,
				baseRef: nextLocation.card.baseRef,
				useWorktree: nextLocation.card.useWorktree,
				pinned: nextLocation.card.pinned,
				updatedAt: nextLocation.card.updatedAt,
			});
		}
		if (hasTaskPatchChange(previousLocation.card, nextLocation.card)) {
			commands.push({
				kind: "patch_task",
				taskId,
				agentId: nextLocation.card.agentId ?? null,
				baseRefPinned: nextLocation.card.baseRefPinned ?? null,
				workingDirectory: nextLocation.card.workingDirectory ?? null,
				branch: nextLocation.card.branch ?? null,
				updatedAt: nextLocation.card.updatedAt,
			});
		}
		if (previousLocation.columnId !== nextLocation.columnId) {
			commands.push({
				kind: "move_task",
				taskId,
				sourceColumnId: previousLocation.columnId,
				targetColumnId: nextLocation.columnId,
				targetIndex: nextLocation.index,
				updatedAt: nextLocation.card.updatedAt,
			});
		}
	}

	const projectedBeforeReorder = applyProjectBoardCommands(before, commands).board;
	for (const column of after.columns) {
		const projectedColumn = projectedBeforeReorder.columns.find((candidate) => candidate.id === column.id);
		const taskIds = column.cards.map((card) => card.id);
		if (
			projectedColumn &&
			projectedColumn.cards.length === taskIds.length &&
			taskIds.some((taskId, index) => projectedColumn.cards[index]?.id !== taskId)
		) {
			commands.push({ kind: "reorder_column", columnId: column.id, taskIds });
		}
	}

	const previousDependencies = dependencyById(before.dependencies);
	const nextDependencies = dependencyById(after.dependencies);
	for (const dependencyId of previousDependencies.keys()) {
		if (!nextDependencies.has(dependencyId)) {
			commands.push({ kind: "remove_dependency", dependencyId });
		}
	}
	for (const dependency of after.dependencies) {
		const previous = previousDependencies.get(dependency.id);
		if (
			previous &&
			previous.fromTaskId === dependency.fromTaskId &&
			previous.toTaskId === dependency.toTaskId &&
			previous.createdAt === dependency.createdAt
		) {
			continue;
		}
		if (previous) {
			commands.push({ kind: "remove_dependency", dependencyId: dependency.id });
		}
		commands.push({
			kind: "add_dependency",
			firstTaskId: dependency.fromTaskId,
			secondTaskId: dependency.toTaskId,
			dependencyId: dependency.id,
			createdAt: dependency.createdAt,
		});
	}

	return commands;
}

export function applyPendingProjectBoardCommands(
	board: BoardData,
	commandBatches: Iterable<readonly RuntimeProjectBoardCommand[]>,
): BoardData {
	let projected = board;
	for (const commands of commandBatches) {
		projected = applyProjectBoardCommands(projected, commands).board;
	}
	return projected;
}
