import { createContext, type ReactNode, useContext, useMemo } from "react";

// ---------------------------------------------------------------------------
// Stable card actions — callbacks that maintain referential identity across
// renders (typically useCallback-wrapped in App.tsx). These rarely change, so
// placing them in their own context avoids unnecessary re-renders.
//
// PERF: If profiling shows these callbacks changing identity too often, wrap
// the value object in useMemo with an explicit dependency list. Currently the
// parent (App.tsx) already stabilises them via useCallback.
// ---------------------------------------------------------------------------

export interface StableCardActions {
	onStartTask?: (taskId: string) => void;
	onRestartSessionTask?: (taskId: string) => void;
	onMoveToTrashTask?: (taskId: string) => void;
	onRestoreFromTrashTask?: (taskId: string) => void;
	onCancelAutomaticTaskAction?: (taskId: string) => void;
	onRegenerateTitleTask?: (taskId: string) => void;
	onUpdateTaskTitle?: (taskId: string, title: string) => void;
	onTogglePinTask?: (taskId: string) => void;
	onHardDeleteTrashTask?: (taskId: string) => void;
	onMigrateWorkingDirectory?: (taskId: string, direction: "isolate" | "de-isolate") => void;
	onRequestDisplaySummary?: (taskId: string) => void;
	onTerminalWarmup?: (taskId: string) => void;
	onTerminalCancelWarmup?: (taskId: string) => void;
	onFlagForDebug?: (taskId: string) => void;
}

// ---------------------------------------------------------------------------
// Reactive card state — values that change on a per-render or per-interaction
// basis. Kept separate so that changes here only re-render consumers of this
// context, not consumers of StableCardActions.
//
// PERF: If re-renders from this context become a bottleneck (e.g. hundreds of
// visible cards), the first lever is React.memo on BoardCard. The second is
// splitting individual high-churn values (like moveToTrashLoadingById) into
// their own context or moving them back to props for targeted delivery.
// ---------------------------------------------------------------------------

export interface ReactiveCardState {
	moveToTrashLoadingById: Record<string, boolean>;
	migratingTaskId: string | null;
	isLlmGenerationDisabled: boolean;
	showSummaryOnCards: boolean;
	uncommittedChangesOnCardsEnabled: boolean;
	showRunningTaskEmergencyActions: boolean;
}

const StableCardActionsContext = createContext<StableCardActions | null>(null);
const ReactiveCardStateContext = createContext<ReactiveCardState | null>(null);

export function useStableCardActions(): StableCardActions {
	const ctx = useContext(StableCardActionsContext);
	if (!ctx) {
		throw new Error("useStableCardActions must be used within a CardActionsProvider");
	}
	return ctx;
}

export function useReactiveCardState(): ReactiveCardState {
	const ctx = useContext(ReactiveCardStateContext);
	if (!ctx) {
		throw new Error("useReactiveCardState must be used within a CardActionsProvider");
	}
	return ctx;
}

export function CardActionsProvider({
	children,
	stable,
	reactive,
}: {
	children: ReactNode;
	stable: StableCardActions;
	reactive: ReactiveCardState;
}): React.ReactElement {
	// Memoise the stable value so downstream consumers only re-render when the
	// handler references actually change. The reactive value intentionally does
	// NOT get memoised — it is expected to change on most renders.
	const stableValue = useMemo(
		() => stable,
		// eslint-disable-next-line react-hooks/exhaustive-deps -- individual handler references
		[
			stable.onStartTask,
			stable.onRestartSessionTask,
			stable.onMoveToTrashTask,
			stable.onRestoreFromTrashTask,
			stable.onCancelAutomaticTaskAction,
			stable.onRegenerateTitleTask,
			stable.onUpdateTaskTitle,
			stable.onTogglePinTask,
			stable.onHardDeleteTrashTask,
			stable.onMigrateWorkingDirectory,
			stable.onRequestDisplaySummary,
			stable.onTerminalWarmup,
			stable.onTerminalCancelWarmup,
			stable.onFlagForDebug,
		],
	);

	return (
		<StableCardActionsContext.Provider value={stableValue}>
			<ReactiveCardStateContext.Provider value={reactive}>{children}</ReactiveCardStateContext.Provider>
		</StableCardActionsContext.Provider>
	);
}
