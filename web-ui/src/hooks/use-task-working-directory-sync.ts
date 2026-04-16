import type { Dispatch, SetStateAction } from "react";
import { useEffect } from "react";
import type { TaskWorkingDirectoryUpdate } from "@/runtime/use-runtime-state-stream";
import type { BoardData } from "@/types";

interface UseTaskWorkingDirectorySyncInput {
	latestTaskWorkingDirectoryUpdate: TaskWorkingDirectoryUpdate | null;
	setBoard: Dispatch<SetStateAction<BoardData>>;
}

export function useTaskWorkingDirectorySync({
	latestTaskWorkingDirectoryUpdate,
	setBoard,
}: UseTaskWorkingDirectorySyncInput): void {
	useEffect(() => {
		if (!latestTaskWorkingDirectoryUpdate) {
			return;
		}
		const { taskId, workingDirectory, useWorktree } = latestTaskWorkingDirectoryUpdate;
		setBoard((current) => {
			for (const column of current.columns) {
				const cardIndex = column.cards.findIndex((c) => c.id === taskId);
				if (cardIndex === -1) {
					continue;
				}
				const card = column.cards[cardIndex]!;
				if (card.workingDirectory === workingDirectory && card.useWorktree === useWorktree) {
					return current;
				}
				const updatedCards = [...column.cards];
				updatedCards[cardIndex] = { ...card, workingDirectory, useWorktree, updatedAt: Date.now() };
				return {
					...current,
					columns: current.columns.map((col) => (col.id === column.id ? { ...col, cards: updatedCards } : col)),
				};
			}
			return current;
		});
	}, [latestTaskWorkingDirectoryUpdate, setBoard]);
}
