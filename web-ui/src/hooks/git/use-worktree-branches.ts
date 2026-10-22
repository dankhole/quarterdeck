import { useMemo } from "react";
import { useTaskRepositoryInfosValue } from "@/stores/project-metadata-store";
import type { BoardData } from "@/types";
import { deriveWorktreeBranches } from "./worktree-branches";

export function useWorktreeBranches(projectId: string | null, board: BoardData): Map<string, string> {
	const repositoryInfos = useTaskRepositoryInfosValue(projectId);
	return useMemo(() => deriveWorktreeBranches(board, repositoryInfos), [board, repositoryInfos]);
}
