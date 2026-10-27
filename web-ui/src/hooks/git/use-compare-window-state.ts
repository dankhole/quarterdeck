import { useCallback, useLayoutEffect, useReducer } from "react";
import { createInitialBoardData } from "@/data/board-data";
import { applyAuthoritativeProjectState, type ProjectBoardSessionsState } from "@/hooks/project/project-sync";
import { mergeProjectStateByRevision } from "@/runtime/project-state-ordering";
import { fetchProjectState } from "@/runtime/project-state-query";
import type { RuntimeProjectStateResponse } from "@/runtime/types";
import { useRuntimeStateStream } from "@/runtime/use-runtime-state-stream";
import { useTrpcQuery } from "@/runtime/use-trpc-query";
import { replaceProjectMetadata, setProjectMetadataScope, setProjectPath } from "@/stores/project-metadata-store";
import type { CompareWindowTarget } from "../../../../src/shared/compare-window-contract";
import { type CompareWindowContext, resolveCompareWindowContext } from "./compare-window-state";

interface ReviewProjectState {
	readonly projectId: string | null;
	readonly snapshot: RuntimeProjectStateResponse | null;
	readonly state: ProjectBoardSessionsState;
}

interface ScopedProjectSnapshot {
	readonly projectId: string;
	readonly snapshot: RuntimeProjectStateResponse;
}

function applyReviewSnapshot(current: ReviewProjectState, incoming: ScopedProjectSnapshot): ReviewProjectState {
	const sameProject = current.projectId === incoming.projectId;
	const snapshot = mergeProjectStateByRevision(sameProject ? current.snapshot : null, incoming.snapshot);
	const result = applyAuthoritativeProjectState({
		currentState: sameProject ? current.state : { board: createInitialBoardData(), sessions: {} },
		currentVersion: { projectId: current.projectId, revision: current.snapshot?.revision ?? null },
		currentProjectId: incoming.projectId,
		incomingProjectState: snapshot,
		cachedRestore: null,
	});
	return result ? { projectId: incoming.projectId, snapshot, state: result.nextState } : current;
}

export function useCompareWindowState(target: CompareWindowTarget): CompareWindowContext {
	const stream = useRuntimeStateStream(target.projectId);
	const [applied, apply] = useReducer(applyReviewSnapshot, {
		projectId: null,
		snapshot: null,
		state: { board: createInitialBoardData(), sessions: {} },
	});
	const scopedSnapshot = applied.projectId === target.projectId ? applied.snapshot : null;
	const fetchInitialState = useCallback(
		async (): Promise<ScopedProjectSnapshot> => ({
			projectId: target.projectId,
			snapshot: await fetchProjectState(target.projectId),
		}),
		[target.projectId],
	);
	// A stream snapshot can omit projectState. Hydrate once through the same read seam
	// as the main app; useTrpcQuery fences responses by request generation and unmount.
	const initialState = useTrpcQuery({
		enabled:
			stream.hasReceivedSnapshot &&
			stream.currentProjectId === target.projectId &&
			!stream.isRuntimeDisconnected &&
			stream.projectState === null &&
			scopedSnapshot === null,
		queryFn: fetchInitialState,
	});
	useLayoutEffect(() => {
		setProjectMetadataScope(target.projectId);
		return () => setProjectMetadataScope(null);
	}, [target.projectId]);
	useLayoutEffect(() => {
		if (stream.currentProjectId !== target.projectId) return;
		if (stream.projectState) apply({ projectId: target.projectId, snapshot: stream.projectState });
		if (initialState.data?.projectId === target.projectId) apply(initialState.data);
	}, [stream.currentProjectId, stream.projectState, initialState.data, target.projectId]);
	useLayoutEffect(() => {
		if (stream.currentProjectId !== target.projectId) return;
		setProjectPath(target.projectId, scopedSnapshot?.repoPath ?? null);
		replaceProjectMetadata(target.projectId, stream.projectMetadata);
	}, [stream.currentProjectId, stream.projectMetadata, scopedSnapshot, target.projectId]);
	if (initialState.isError && scopedSnapshot === null) {
		return {
			status: "error",
			message: `Could not load the captured project's state: ${initialState.error?.message ?? "Unknown runtime read error."}`,
		};
	}
	if (scopedSnapshot?.availability?.status === "unavailable") {
		return {
			status: "error",
			message: "The captured project repository is unavailable. Restore its folder to continue reviewing.",
		};
	}
	return resolveCompareWindowContext({
		target,
		currentProjectId: stream.currentProjectId,
		projects: stream.projects,
		board: scopedSnapshot === null ? null : applied.state.board,
		metadata: stream.projectMetadata,
		hasReceivedSnapshot: stream.hasReceivedSnapshot,
		streamError: stream.streamError,
		isRuntimeDisconnected: stream.isRuntimeDisconnected,
	});
}
