import { useCallback, useSyncExternalStore } from "react";
import type { DiffLineComment } from "@/components/git/panels/diff-viewer-utils";
import { type ReviewDraft, type ReviewDrafts, reviewDrafts } from "@/state/review-drafts";

export interface UseReviewDraftResult extends ReviewDraft {
	setComments: (
		update: Map<string, DiffLineComment> | ((previous: Map<string, DiffLineComment>) => Map<string, DiffLineComment>),
	) => void;
}

export function useReviewDraft(key: string, store: ReviewDrafts = reviewDrafts): UseReviewDraftResult {
	const subscribe = useCallback((listener: () => void) => store.subscribe(key, listener), [key, store]);
	const getSnapshot = useCallback(() => store.get(key), [key, store]);
	const draft = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
	const setComments = useCallback<UseReviewDraftResult["setComments"]>(
		(update) => store.updateComments(key, (previous) => (typeof update === "function" ? update(previous) : update)),
		[key, store],
	);
	return { ...draft, setComments };
}
