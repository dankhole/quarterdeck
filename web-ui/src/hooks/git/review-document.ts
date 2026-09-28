import type { FileBrowserScopeOptions } from "./file-browser-scope";
import { createFileBrowserContentScopeKey } from "./file-browser-scope";

export interface ReviewRevisionPair {
	readonly kind: "commit" | "compare" | "working-copy" | "conflict" | "auto-merge";
	readonly base: string;
	readonly head: string;
	readonly mode?: "two_dot" | "three_dot";
	readonly version?: string | number;
}

export interface ReviewScope {
	readonly repository: FileBrowserScopeOptions;
	readonly revisions: ReviewRevisionPair;
}

export type ReviewContent =
	| { readonly kind: "patch"; readonly patch: string }
	| { readonly kind: "text"; readonly oldText: string | null | undefined; readonly newText: string }
	| { readonly kind: "binary" | "loading" | "unavailable"; readonly message?: string };

/** Immutable review snapshots never carry a writable scope or save capability. */
export interface ReviewDocument {
	readonly key: string;
	readonly kind: "review";
	readonly readOnly: true;
	readonly repositoryKey: string;
	readonly revisions: ReviewRevisionPair;
	readonly oldPath: string | null;
	readonly newPath: string | null;
	readonly path: string;
	readonly content: ReviewContent;
}

export function createReviewDocument(
	scope: ReviewScope,
	file: { path: string; previousPath?: string; status?: string; contentRevision?: string },
	content: ReviewContent,
): ReviewDocument {
	const repositoryKey = createFileBrowserContentScopeKey(scope.repository);
	const oldPath = file.status === "added" || file.status === "untracked" ? null : (file.previousPath ?? file.path);
	const newPath = file.status === "deleted" ? null : file.path;
	const { kind, base, head, mode, version } = scope.revisions;
	return {
		kind: "review",
		readOnly: true,
		repositoryKey,
		revisions: scope.revisions,
		oldPath,
		newPath,
		path: newPath ?? oldPath ?? file.path,
		content,
		key: JSON.stringify([
			"review",
			repositoryKey,
			kind,
			base,
			head,
			mode,
			version ?? file.contentRevision,
			oldPath,
			newPath,
		]),
	};
}
