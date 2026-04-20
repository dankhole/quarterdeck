import { Fzf } from "fzf";
import type { RuntimeGitRef } from "@/runtime/types";

export interface BranchSelectorSections {
	detachedRef: RuntimeGitRef | null;
	pinnedLocal: RuntimeGitRef[];
	unpinnedLocal: RuntimeGitRef[];
	filteredRemote: RuntimeGitRef[];
}

export function resolveBranchSelectorSections(
	branches: RuntimeGitRef[] | null,
	pinnedBranches: string[] | undefined,
	query: string,
): BranchSelectorSections {
	const refs = branches ?? [];
	const pinnedSet = new Set(pinnedBranches ?? []);
	const detachedRef = refs.find((ref) => ref.type === "detached") ?? null;
	const localBranches = refs.filter((ref) => ref.type === "branch");
	const remoteBranches = refs.filter((ref) => ref.type === "remote");
	const normalizedQuery = query.trim();
	const filteredLocal = normalizedQuery
		? new Fzf(localBranches, { selector: (ref) => ref.name }).find(normalizedQuery).map((result) => result.item)
		: localBranches;
	const filteredRemote = normalizedQuery
		? new Fzf(remoteBranches, { selector: (ref) => ref.name }).find(normalizedQuery).map((result) => result.item)
		: remoteBranches;

	return {
		detachedRef,
		pinnedLocal: pinnedSet.size > 0 ? filteredLocal.filter((ref) => pinnedSet.has(ref.name)) : [],
		unpinnedLocal: pinnedSet.size > 0 ? filteredLocal.filter((ref) => !pinnedSet.has(ref.name)) : filteredLocal,
		filteredRemote,
	};
}
