import type { RuntimeTaskRepositoryInfoResponse } from "@/runtime/types";
import type { BoardData } from "@/types";
import { arePathIdentitiesEqual } from "@/utils/path-identity";

export function deriveWorktreeBranches(
	board: BoardData,
	repositoryInfos: Readonly<Record<string, RuntimeTaskRepositoryInfoResponse | null>>,
): Map<string, string> {
	const branches = new Map<string, string>();
	for (const column of board.columns) {
		if (column.id === "trash") continue;
		for (const card of column.cards) {
			const info = repositoryInfos[card.id];
			// card.branch is a creation/recovery hint; only an observed attachment
			// can reserve a branch. Unknown checkouts defer to Git's runtime checks.
			if (
				card.useWorktree === false ||
				!info?.exists ||
				info.isDetached ||
				!info.branch ||
				info.baseRef !== card.baseRef ||
				(card.workingDirectory && !arePathIdentitiesEqual(card.workingDirectory, info.path))
			)
				continue;
			branches.set(info.branch, card.title ?? card.id);
		}
	}
	return branches;
}
