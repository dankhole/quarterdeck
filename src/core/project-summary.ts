import type { RuntimeBoardData, RuntimeProjectSummary, RuntimeProjectTaskCounts } from "./api-contract.js";

export function countProjectTasksByColumn(board: RuntimeBoardData): RuntimeProjectTaskCounts {
	const counts: RuntimeProjectTaskCounts = {
		backlog: 0,
		in_progress: 0,
		review: 0,
		trash: 0,
	};
	for (const column of board.columns) {
		counts[column.id] += column.cards.length;
	}
	return counts;
}

export function deriveProjectSummary(input: {
	projectId: string;
	repoPath: string;
	board: RuntimeBoardData;
	boardRevision: number;
}): RuntimeProjectSummary {
	const normalized = input.repoPath.replaceAll("\\", "/").replace(/\/+$/g, "");
	const segments = normalized.split("/").filter((segment) => segment.length > 0);
	return {
		id: input.projectId,
		path: input.repoPath,
		name: segments[segments.length - 1] ?? normalized,
		boardRevision: input.boardRevision,
		taskCounts: countProjectTasksByColumn(input.board),
	};
}
