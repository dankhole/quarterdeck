import { useCallback, useEffect, useMemo, useState } from "react";

export type ScopeMode = "contextual" | "home_override" | "branch_view";

export type ResolvedScope =
	| { type: "home"; projectId: string }
	| { type: "task"; taskId: string; baseRef: string; projectId: string; branch: string | null }
	| { type: "branch_view"; ref: string; projectId: string; taskId?: string; baseRef?: string };

interface ScopeState {
	mode: ScopeMode;
	branchViewRef: string | null;
}

const initialState: ScopeState = { mode: "contextual", branchViewRef: null };

export function useScopeContext(options: {
	selectedTaskId: string | null;
	selectedCard: { baseRef: string; branch?: string | null } | null;
	currentProjectId: string | null;
}): {
	scopeMode: ScopeMode;
	resolvedScope: ResolvedScope | null;
	switchToHome: () => void;
	returnToContextual: () => void;
	selectBranchView: (ref: string) => void;
} {
	const { selectedTaskId, selectedCard, currentProjectId } = options;

	const [state, setState] = useState<ScopeState>(initialState);

	// Auto-reset when the selected task changes
	useEffect(() => {
		setState(initialState);
	}, [selectedTaskId]);

	// Auto-reset when the project changes
	useEffect(() => {
		setState(initialState);
	}, [currentProjectId]);

	const resolvedScope = useMemo((): ResolvedScope | null => {
		if (currentProjectId === null) {
			return null;
		}

		if (state.mode === "branch_view" && state.branchViewRef !== null) {
			return {
				type: "branch_view",
				ref: state.branchViewRef,
				projectId: currentProjectId,
				...(selectedTaskId && selectedCard ? { taskId: selectedTaskId, baseRef: selectedCard.baseRef } : {}),
			};
		}

		if (state.mode === "home_override") {
			return { type: "home", projectId: currentProjectId };
		}

		// mode === "contextual"
		if (selectedTaskId && selectedCard) {
			return {
				type: "task",
				taskId: selectedTaskId,
				baseRef: selectedCard.baseRef,
				projectId: currentProjectId,
				branch: selectedCard.branch ?? null,
			};
		}

		return { type: "home", projectId: currentProjectId };
	}, [state.mode, state.branchViewRef, currentProjectId, selectedTaskId, selectedCard]);

	const switchToHome = useCallback(() => {
		setState({ mode: "home_override", branchViewRef: null });
	}, []);

	const returnToContextual = useCallback(() => {
		setState({ mode: "contextual", branchViewRef: null });
	}, []);

	const selectBranchView = useCallback((ref: string) => {
		setState({ mode: "branch_view", branchViewRef: ref });
	}, []);

	return {
		scopeMode: state.mode,
		resolvedScope,
		switchToHome,
		returnToContextual,
		selectBranchView,
	};
}
