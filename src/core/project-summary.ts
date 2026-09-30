import type {
	RuntimeBoardData,
	RuntimeProjectAvailability,
	RuntimeProjectSummary,
	RuntimeProjectTaskCounts,
} from "./api-contract.js";

export function countProjectTasksByColumn(board: RuntimeBoardData): RuntimeProjectTaskCounts {
	const counts: RuntimeProjectTaskCounts = {
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
	displayName?: string;
	metadataRevision?: number;
	availability?: RuntimeProjectAvailability;
	board: RuntimeBoardData;
	boardRevision: number;
	folderOnly?: boolean;
}): RuntimeProjectSummary {
	const normalized = input.repoPath.replaceAll("\\", "/").replace(/\/+$/g, "");
	const segments = normalized.split("/").filter((segment) => segment.length > 0);
	return {
		id: input.projectId,
		path: input.repoPath,
		name: input.displayName ?? segments[segments.length - 1] ?? normalized,
		...(input.displayName ? { displayName: input.displayName } : {}),
		metadataRevision: input.metadataRevision ?? 0,
		availability: input.availability ?? { status: "available" },
		...(input.folderOnly ? { folderOnly: true } : {}),
		boardRevision: input.boardRevision,
		taskCounts: countProjectTasksByColumn(input.board),
	};
}
