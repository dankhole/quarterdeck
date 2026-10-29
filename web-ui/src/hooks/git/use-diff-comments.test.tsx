import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DiffLineComment } from "@/components/git/panels/diff-viewer-utils";
import { type ReviewSendResult, reviewDrafts } from "@/state/review-drafts";
import { type UseDiffCommentsResult, useDiffComments } from "./use-diff-comments";
import { useReviewDraft } from "./use-review-draft";

let root: Root;
let container: HTMLDivElement;
let latest: UseDiffCommentsResult;
let currentComments: Map<string, DiffLineComment>;
let testId = 0;
let originalKey: string;
let currentKey: string;
let submit: (text: string) => Promise<ReviewSendResult>;
let previousActEnvironment: boolean | undefined;
function commentFor(filePath: string, lineNumber = 1) {
	return [...currentComments.values()].find(
		(comment) => comment.filePath === filePath && comment.lineNumber === lineNumber,
	);
}

function Harness({ draftKey }: { draftKey: string }) {
	const draft = useReviewDraft(draftKey);
	currentComments = draft.comments;
	latest = useDiffComments({
		reviewDraftKey: draftKey,
		comments: draft.comments,
		onCommentsChange: draft.setComments,
		onSendToTerminal: submit,
	});
	return null;
}
function render(key = currentKey) {
	currentKey = key;
	act(() => root.render(<Harness draftKey={key} />));
}
function add(file = "a.ts", line = 1, text = "Review") {
	latest.handleAddComment(file, line, `original ${file}:${line}`, "added");
	latest.handleUpdateComment(file, line, "added", text);
}
function deferred() {
	let resolve!: (value: ReviewSendResult) => void;
	const promise = new Promise<ReviewSendResult>((done) => {
		resolve = done;
	});
	return { promise, resolve };
}

beforeEach(() => {
	previousActEnvironment = (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
	(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
	container = document.createElement("div");
	document.body.append(container);
	root = createRoot(container);
	originalKey = `hook-review-${++testId}`;
	currentKey = originalKey;
	submit = vi.fn(async () => ({ ok: true }));
	render();
});
afterEach(() => {
	act(() => root.unmount());
	container.remove();
	(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = previousActEnvironment;
});

describe("useDiffComments", () => {
	it("saves, edits, and cancels without losing written text or original anchors", () => {
		act(() => {
			add();
			latest.handleSaveComment("a.ts", 1, "added");
		});
		expect(commentFor("a.ts")).toMatchObject({ comment: "Review", editing: false });
		act(() => {
			latest.handleEditComment("a.ts", 1, "added");
			latest.handleUpdateComment("a.ts", 1, "added", "Latest edit");
			latest.handleCancelEditComment("a.ts", 1, "added");
		});
		expect(commentFor("a.ts")).toMatchObject({
			comment: "Latest edit",
			editing: false,
			lineText: "original a.ts:1",
		});
		act(() => {
			latest.handleAddComment("empty.ts", 2, "code", "context");
			latest.handleSaveComment("empty.ts", 2, "context");
		});
		expect(commentFor("empty.ts", 2)).toBeDefined();
		act(() => latest.handleCancelEditComment("empty.ts", 2, "context"));
		expect(commentFor("empty.ts", 2)).toBeUndefined();
	});

	it("keeps same-address snapshot drafts independent by immutable map key and sends both source contexts", async () => {
		submit = vi.fn(async () => ({ ok: false, message: "Retained for inspection" }));
		render();
		act(() => {
			latest.handleAddComment("a.ts", 1, "original code", "added", "original snapshot");
			latest.handleUpdateComment("a.ts", 1, "added", "Original review");
			latest.handleSaveComment("a.ts", 1, "added");
		});
		const originalId = [...currentComments.keys()][0]!;
		act(() => latest.handleAddComment("a.ts", 1, "replacement code", "added", "replacement snapshot"));
		const replacementId = [...currentComments.keys()].find((key) => key !== originalId)!;
		expect(replacementId).toBeTruthy();
		expect(originalId).not.toContain("snapshot");
		act(() => {
			latest.handleUpdateComment("a.ts", 1, "added", "New review", replacementId);
			latest.handleSaveComment("a.ts", 1, "added", replacementId);
			latest.handleUpdateComment("a.ts", 1, "added", "Ambiguous edit must not apply");
		});
		expect(currentComments.get(originalId)).toMatchObject({
			comment: "Original review",
			lineText: "original code",
			anchorRevision: "original snapshot",
		});
		expect(currentComments.get(replacementId)).toMatchObject({
			comment: "New review",
			lineText: "replacement code",
			anchorRevision: "replacement snapshot",
		});
		await act(async () => latest.handleSendComments());
		expect(submit).toHaveBeenCalledExactlyOnceWith(
			"a.ts:1 | original code\n> Original review\n\na.ts:1 | replacement code\n> New review",
		);
		act(() => {
			latest.handleEditComment("a.ts", 1, "added", originalId);
			latest.handleUpdateComment("a.ts", 1, "added", "Edited original", originalId);
			latest.handleCancelEditComment("a.ts", 1, "added", originalId);
		});
		expect(currentComments.get(originalId)).toMatchObject({ comment: "Edited original", editing: false });
		expect(currentComments.get(replacementId)).toMatchObject({ comment: "New review", editing: false });
		act(() => latest.handleDeleteComment("a.ts", 1, "added", originalId));
		expect(currentComments.has(originalId)).toBe(false);
		expect(currentComments.get(replacementId)?.comment).toBe("New review");
	});

	it("sends latest edits in all comments in deterministic order without requiring save", async () => {
		act(() => {
			add("z.ts", 3, "Last");
			add("a.ts", 5, "Before edit");
			add("a.ts", 2, "First");
			latest.handleUpdateComment("a.ts", 5, "added", "Latest\nsecond line");
			latest.handleAddComment("empty.ts", 1, "ignored", "context");
		});
		expect(latest.nonEmptyCount).toBe(3);
		expect(latest.fileCount).toBe(2);
		const formattedLength = latest.formattedLength;
		await act(async () => latest.handleSendComments());
		expect(submit).toHaveBeenCalledExactlyOnceWith(
			"a.ts:2 | original a.ts:2\n> First\n\na.ts:5 | original a.ts:5\n> Latest\n> second line\n\nz.ts:3 | original z.ts:3\n> Last",
		);
		expect(formattedLength).toBe(vi.mocked(submit).mock.calls[0]?.[0].length);
		expect(currentComments.size).toBe(1);
		expect(latest.nonEmptyCount).toBe(0);
	});

	it("retains drafts through same-window navigation and full unmount", () => {
		act(() => add());
		render(`${originalKey}-other-task`);
		expect(latest.hasAnyComments).toBe(false);
		act(() => add("other.ts"));
		render(originalKey);
		expect(currentComments.size).toBe(1);
		expect(commentFor("a.ts")?.comment).toBe("Review");
		act(() => root.render(null));
		render(originalKey);
		expect(commentFor("a.ts")?.comment).toBe("Review");
	});

	it("locks duplicate sends across navigation/remount and scopes acknowledgement to original owner", async () => {
		const pending = deferred();
		submit = vi.fn(() => pending.promise);
		render();
		act(() => add());
		let sent!: Promise<void>;
		act(() => {
			sent = latest.handleSendComments();
		});
		expect(latest.isSending).toBe(true);
		render(`${originalKey}-other`);
		act(() => add("other.ts", 1, "Other task"));
		const otherComments = currentComments;
		render(originalKey);
		expect(latest.isSending).toBe(true);
		await act(async () => latest.handleSendComments());
		expect(submit).toHaveBeenCalledTimes(1);
		act(() => root.render(null));
		await act(async () => {
			pending.resolve({ ok: true });
			await sent;
		});
		render(`${originalKey}-other`);
		expect(currentComments).toBe(otherComments);
		render(originalKey);
		expect(latest.hasAnyComments).toBe(false);
		expect(latest.isSending).toBe(false);
	});

	it("preserves post-send edits and new comments when acknowledgement arrives", async () => {
		const pending = deferred();
		submit = () => pending.promise;
		render();
		act(() => add());
		let sent!: Promise<void>;
		act(() => {
			sent = latest.handleSendComments();
		});
		act(() => {
			latest.handleUpdateComment("a.ts", 1, "added", "Later edit");
			add("b.ts", 2, "New comment");
		});
		await act(async () => {
			pending.resolve({ ok: true });
			await sent;
		});
		expect([...currentComments.values()].map((comment) => comment.comment)).toEqual(["Later edit", "New comment"]);
	});

	it("retains failure and thrown-delivery state across navigation and permits retry", async () => {
		submit = vi.fn(async () => ({ ok: false, message: "Not ready" }));
		render();
		act(() => add());
		await act(async () => latest.handleSendComments());
		expect(latest.sendError).toBe("Not ready");
		render(`${originalKey}-other`);
		render(originalKey);
		expect(latest.sendError).toBe("Not ready");
		expect(latest.nonEmptyCount).toBe(1);
		submit = async () => {
			throw new Error("Disconnected");
		};
		render();
		await act(async () => latest.handleSendComments());
		expect(latest.sendError).toContain("Delivery could not be confirmed");
		expect(latest.isSending).toBe(false);
		submit = async () => ({ ok: true });
		render();
		await act(async () => latest.handleSendComments());
		expect(latest.sendError).toBeNull();
		expect(latest.hasAnyComments).toBe(false);
	});

	it("rejects retained send callbacks after scope changes or unmount, before dispatch", async () => {
		act(() => add());
		const originalSend = latest.handleSendComments;
		render(`${originalKey}-other`);
		await act(async () => originalSend());
		expect(submit).not.toHaveBeenCalled();
		expect(reviewDrafts.get(originalKey).isSending).toBe(false);
		render(originalKey);
		const retainedSend = latest.handleSendComments;
		act(() => root.render(null));
		await act(async () => retainedSend());
		expect(submit).not.toHaveBeenCalled();
		expect(reviewDrafts.get(originalKey).comments.size).toBe(1);
	});

	it("does not register global paste or send shortcuts", async () => {
		act(() => add());
		await act(async () => {
			document.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", metaKey: true, bubbles: true }));
			document.dispatchEvent(
				new KeyboardEvent("keydown", { key: "Enter", ctrlKey: true, shiftKey: true, bubbles: true }),
			);
		});
		expect(submit).not.toHaveBeenCalled();
		expect(reviewDrafts.get(originalKey).comments.size).toBe(1);
	});
});
