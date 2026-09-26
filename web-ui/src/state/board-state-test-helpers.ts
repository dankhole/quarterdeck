import { createInitialBoardData } from "@/data/board-data";
import { addTaskToColumn } from "@/state/board-state";

export function createUnstartedBoard(taskPrompts: string[]): {
	board: ReturnType<typeof createInitialBoardData>;
	taskIdByPrompt: Record<string, string>;
} {
	let board = createInitialBoardData();
	for (const taskPrompt of taskPrompts) {
		board = addTaskToColumn(board, "review", {
			prompt: taskPrompt,
			baseRef: "main",
		});
	}
	const unstartedCards = board.columns.find((column) => column.id === "review")?.cards ?? [];
	const taskIdByPrompt: Record<string, string> = {};
	for (const card of unstartedCards) {
		taskIdByPrompt[card.prompt] = card.id;
	}
	return {
		board,
		taskIdByPrompt,
	};
}

export function requireTaskId(taskId: string | undefined, taskPrompt: string): string {
	if (!taskId) {
		throw new Error(`Missing task id for ${taskPrompt}`);
	}
	return taskId;
}
