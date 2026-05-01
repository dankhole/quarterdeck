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
			taskId: resolvedScope.taskId ?? null,
			baseRef: resolvedScope.baseRef,
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
	displayBranchLabel,
}: {
	resolvedScope: ResolvedScope | null;
	displayBranchLabel: string | null | undefined;
}): string | null {
	if (resolvedScope?.type === "branch_view") {
		return resolvedScope.ref;
	}
	return displayBranchLabel ?? null;
}
