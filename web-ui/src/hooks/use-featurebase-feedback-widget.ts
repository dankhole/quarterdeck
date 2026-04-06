import { useCallback } from "react";

/**
 * Bounded retry delays (ms) after the initial attempt.
 * After these are exhausted the hook stays in "error".
 */
export const RETRY_DELAYS = [2_000, 5_000] as const;

// ---------------------------------------------------------------------------
// Featurebase auth readiness state machine
// ---------------------------------------------------------------------------

/** Tracks whether the Featurebase SDK has been successfully identified. */
export type FeaturebaseAuthState = "idle" | "loading" | "ready" | "error";

export interface FeaturebaseFeedbackState {
	/** Current identify readiness. */
	authState: FeaturebaseAuthState;
	/** Increments whenever the SDK confirms that the feedback widget opened. */
	widgetOpenCount: number;
	/** Authenticates the current user, then opens the feedback widget. */
	openFeedbackWidget: () => Promise<void>;
}

// ---------------------------------------------------------------------------
// Hook
// ---------------------------------------------------------------------------

export function useFeaturebaseFeedbackWidget(_input: { workspaceId: string | null }): FeaturebaseFeedbackState {
	// Without Cline OAuth, Featurebase JWT auth is not available.
	// The widget cannot be opened without authentication.
	const openFeedbackWidget = useCallback(async (): Promise<void> => {}, []);

	return { authState: "idle", widgetOpenCount: 0, openFeedbackWidget };
}
