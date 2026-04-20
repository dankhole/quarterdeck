import type { ResolvedScope } from "@/hooks/git";

export function formatCardDetailSidePanelPercent(sidePanelRatio: number): string {
	return `${(sidePanelRatio * 100).toFixed(1)}%`;
}

export function resolveCardDetailFileBrowserScope(resolvedScope: ResolvedScope | null) {
	if (resolvedScope?.type === "task") {
		return {
			taskId: resolvedScope.taskId,
			baseRef: resolvedScope.baseRef,
			ref: undefined,
		};
	}

	if (resolvedScope?.type === "branch_view") {
		return {
			taskId: null,
			baseRef: undefined,
			ref: resolvedScope.ref,
		};
	}

	return {
		taskId: null,
		baseRef: undefined,
		ref: undefined,
	};
}

export function resolveCardDetailBranchPillLabel({
	resolvedScope,
	branch,
	isDetached,
	headCommit,
	fallbackBranch,
}: {
	resolvedScope: ResolvedScope | null;
	branch: string | null | undefined;
	isDetached: boolean | undefined;
	headCommit: string | null | undefined;
	fallbackBranch: string | null | undefined;
}): string | null {
	if (resolvedScope?.type === "branch_view") {
		return resolvedScope.ref;
	}
	if (branch) {
		return branch;
	}
	if (isDetached) {
		return headCommit?.substring(0, 7) ?? null;
	}
	return fallbackBranch ?? headCommit?.substring(0, 7) ?? null;
}
