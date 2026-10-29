import type { DiffLineComment } from "@/components/git/panels/diff-viewer-utils";
import { sortedNonEmptyComments } from "@/hooks/git/diff-comments";

export interface ReviewDraftScope {
	projectId: string | null;
	taskId: string | null;
	taskCreatedAt?: number;
	rootPath?: string | null;
	baseRef?: string | null;
	tab: "uncommitted" | "compare";
	sourceRef?: string | null;
	targetRef?: string | null;
	includeUncommitted?: boolean;
	threeDotDiff?: boolean;
}

export function createReviewDraftKey(scope: ReviewDraftScope): string {
	return JSON.stringify([
		scope.projectId,
		scope.taskId,
		scope.taskCreatedAt ?? null,
		// Task roots resolve asynchronously; identity must not change when metadata arrives.
		scope.taskId ? null : (scope.rootPath ?? null),
		scope.baseRef ?? null,
		scope.tab,
		...(scope.tab === "compare"
			? [
					scope.sourceRef ?? null,
					scope.targetRef ?? null,
					scope.includeUncommitted ?? false,
					scope.threeDotDiff ?? false,
				]
			: []),
	]);
}

export interface ReviewDraft {
	readonly comments: Map<string, DiffLineComment>;
	readonly isSending: boolean;
	readonly sendError: string | null;
}

export interface ReviewSendResult {
	ok: boolean;
	message?: string;
}

const EMPTY_DRAFT: ReviewDraft = { comments: new Map(), isSending: false, sendError: null };

/** Presentation changes do not create unsent content; original payload and anchors do. */
function commentPayloadIdentity(comment: DiffLineComment): string {
	return JSON.stringify([
		comment.filePath,
		comment.lineNumber,
		comment.variant,
		comment.lineText,
		comment.comment,
		comment.anchorRevision ?? null,
	]);
}

/** One browser-window owner. No storage, runtime writes, or mount-lifetime reset. */
export class ReviewDrafts {
	private readonly drafts = new Map<string, ReviewDraft>();
	private readonly listeners = new Map<string, Set<() => void>>();

	get = (key: string): ReviewDraft => this.drafts.get(key) ?? EMPTY_DRAFT;

	subscribe = (key: string, listener: () => void): (() => void) => {
		const listeners = this.listeners.get(key) ?? new Set();
		listeners.add(listener);
		this.listeners.set(key, listeners);
		return () => {
			listeners.delete(listener);
			if (listeners.size === 0) this.listeners.delete(key);
		};
	};

	private set(key: string, draft: ReviewDraft): void {
		if (!draft.comments.size && !draft.isSending && !draft.sendError) this.drafts.delete(key);
		else this.drafts.set(key, draft);
		for (const listener of this.listeners.get(key) ?? []) listener();
	}

	updateComments(key: string, update: (comments: Map<string, DiffLineComment>) => Map<string, DiffLineComment>): void {
		const draft = this.get(key);
		const comments = update(draft.comments);
		if (comments !== draft.comments) this.set(key, { ...draft, comments, sendError: null });
	}

	async send(key: string, submit: (comments: DiffLineComment[]) => Promise<ReviewSendResult>): Promise<boolean> {
		const draft = this.get(key);
		const comments = sortedNonEmptyComments(draft.comments);
		if (draft.isSending || comments.length === 0) return false;
		// Capture immutable values before transport; later presentation edits replace objects.
		const sent = new Map(
			[...draft.comments]
				.filter(([, comment]) => comment.comment.trim().length > 0)
				.map(([address, comment]) => [address, commentPayloadIdentity(comment)]),
		);
		// Lock before invoking the callback: repeat events and remounts see it synchronously.
		this.set(key, { ...draft, isSending: true, sendError: null });
		try {
			const result = await submit(comments);
			const current = this.get(key);
			if (result.ok) {
				// Exact content reverted during send is acknowledged too; changes/new map identities survive.
				const remaining = new Map(
					[...current.comments].filter(
						([address, comment]) => sent.get(address) !== commentPayloadIdentity(comment),
					),
				);
				this.set(key, { comments: remaining, isSending: false, sendError: null });
			} else {
				this.set(key, {
					...current,
					isSending: false,
					sendError: result.message ?? "Review could not be sent. Your draft is saved.",
				});
			}
			return result.ok;
		} catch {
			this.set(key, {
				...this.get(key),
				isSending: false,
				sendError: "Delivery could not be confirmed. Check the agent before resending. Your draft is saved.",
			});
			return false;
		}
	}
}

export const reviewDrafts = new ReviewDrafts();
