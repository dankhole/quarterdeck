export const INTEGRATION_BASE_REF_CANDIDATES = ["main", "master"] as const;

export type RuntimeTaskBaseRefKind = "unresolved" | "inferred" | "pinned";

export type RuntimeTaskBaseRefState =
	| {
			kind: "unresolved";
			baseRef: null;
			isResolved: false;
			isPinned: false;
			tracksBranchChanges: false;
	  }
	| {
			kind: "inferred";
			baseRef: string;
			isResolved: true;
			isPinned: false;
			tracksBranchChanges: true;
	  }
	| {
			kind: "pinned";
			baseRef: string;
			isResolved: true;
			isPinned: true;
			tracksBranchChanges: false;
	  };

export interface RuntimeTaskBaseRefInput {
	baseRef?: string | null;
	baseRefPinned?: boolean | null;
}

/**
 * The board persists only a ref string and a lock bit. A resolved unpinned ref
 * is sync-owned: branch-change inference can replace it even if the user picked
 * the current value manually.
 */
export function normalizeRuntimeBaseRef(baseRef: string | null | undefined): string | null {
	const trimmed = baseRef?.trim();
	return trimmed ? trimmed : null;
}

export function resolveRuntimeTaskBaseRefState(input: RuntimeTaskBaseRefInput): RuntimeTaskBaseRefState {
	const baseRef = normalizeRuntimeBaseRef(input.baseRef);
	if (!baseRef) {
		return {
			kind: "unresolved",
			baseRef: null,
			isResolved: false,
			isPinned: false,
			tracksBranchChanges: false,
		};
	}
	if (input.baseRefPinned === true) {
		return {
			kind: "pinned",
			baseRef,
			isResolved: true,
			isPinned: true,
			tracksBranchChanges: false,
		};
	}
	return {
		kind: "inferred",
		baseRef,
		isResolved: true,
		isPinned: false,
		tracksBranchChanges: true,
	};
}

export function isRuntimeTaskBaseRefResolved(input: RuntimeTaskBaseRefInput): boolean {
	return resolveRuntimeTaskBaseRefState(input).isResolved;
}
