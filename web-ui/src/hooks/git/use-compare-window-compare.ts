import { useCallback, useMemo, useState } from "react";
import { getRuntimeTrpcClient } from "@/runtime/trpc-client";
import { useTrpcQuery } from "@/runtime/use-trpc-query";
import type { CompareWindowTarget } from "../../../../src/shared/compare-window-contract";
import type { CompareWindowContext } from "./compare-window-state";
import type { UseGitViewCompareResult } from "./use-git-view-compare";

/** Navigation and comparison choices belong to this window, not shared UI preferences. */
export function useCompareWindowCompare(
	target: CompareWindowTarget,
	context: CompareWindowContext,
): UseGitViewCompareResult {
	const [sourceRef, setSourceRef] = useState(target.sourceRef);
	const [targetRef, setTargetRef] = useState(target.targetRef);
	const [includeUncommitted, setIncludeUncommitted] = useState(target.includeUncommitted);
	const [threeDotDiff, setThreeDotDiff] = useState(target.threeDotDiff);
	const baseRef = context.status === "ready" ? context.baseRef : null;
	const refsQuery = useCallback(async () => {
		if (target.taskId !== null && baseRef === null) throw new Error("The captured task has no repository base ref.");
		const response = await getRuntimeTrpcClient(target.projectId).project.getGitRefs.query(
			target.taskId !== null && baseRef !== null ? { taskId: target.taskId, baseRef } : null,
		);
		if (!response.ok) throw new Error(response.error ?? "Could not load comparison refs.");
		return response;
	}, [target.projectId, target.taskId, baseRef]);
	const refs = useTrpcQuery({ enabled: context.status === "ready", queryFn: refsQuery });
	const worktreeBranches = useMemo(() => {
		const branches = new Map<string, string>();
		if (context.status === "ready" && context.task && context.branch)
			branches.set(context.branch, context.task.title ?? context.task.id);
		return branches;
	}, [context]);
	const resetToDefaults = useCallback(() => {
		setSourceRef(target.sourceRef);
		setTargetRef(target.targetRef);
	}, [target.sourceRef, target.targetRef]);
	return {
		sourceRef,
		targetRef,
		defaultSourceRef: target.sourceRef,
		defaultTargetRef: target.targetRef,
		setSourceRef,
		setTargetRef,
		resetToDefaults,
		isBrowsing: sourceRef !== target.sourceRef,
		hasOverride: sourceRef !== target.sourceRef || targetRef !== target.targetRef,
		branches: refs.data?.refs ?? null,
		worktreeBranches,
		includeUncommitted,
		setIncludeUncommitted,
		threeDotDiff,
		setThreeDotDiff,
	};
}
