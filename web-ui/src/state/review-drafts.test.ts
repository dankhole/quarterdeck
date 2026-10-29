// @vitest-environment node

import { describe, expect, it, vi } from "vitest";
import type { DiffLineComment } from "@/components/git/panels/diff-viewer-utils";
import { createReviewDraftKey, type ReviewDraftScope, ReviewDrafts, type ReviewSendResult } from "./review-drafts";

const scope: ReviewDraftScope = {
	projectId: "project",
	taskId: "task",
	taskCreatedAt: 1,
	rootPath: "/repo",
	baseRef: "main",
	tab: "compare",
	sourceRef: "feature",
	targetRef: "main",
	includeUncommitted: true,
	threeDotDiff: true,
};
function comment(text = "Review this", filePath = "a.ts", lineNumber = 1): DiffLineComment {
	return { filePath, lineNumber, lineText: "original code", variant: "added", comment: text, editing: true };
}
function deferred() {
	let resolve!: (value: ReviewSendResult) => void;
	const promise = new Promise<ReviewSendResult>((done) => {
		resolve = done;
	});
	return { promise, resolve };
}

describe("ReviewDrafts", () => {
	it("scopes drafts by stable task identity, tab, refs, and comparison options", () => {
		const original = createReviewDraftKey(scope);
		const variants: Partial<ReviewDraftScope>[] = [
			{ projectId: "other" },
			{ taskId: "other" },
			{ taskCreatedAt: 2 },
			{ baseRef: "develop" },
			{ tab: "uncommitted" },
			{ sourceRef: "other" },
			{ targetRef: "other" },
			{ includeUncommitted: false },
			{ threeDotDiff: false },
		];
		for (const change of variants) expect(createReviewDraftKey({ ...scope, ...change })).not.toBe(original);
		expect(createReviewDraftKey({ ...scope, rootPath: undefined })).toBe(original);
		expect(createReviewDraftKey({ ...scope, rootPath: "/resolved-task-root" })).toBe(original);
		expect(createReviewDraftKey({ ...scope, taskId: null, rootPath: "/home-a" })).not.toBe(
			createReviewDraftKey({ ...scope, taskId: null, rootPath: "/home-b" }),
		);
		expect(createReviewDraftKey({ ...scope, tab: "uncommitted", sourceRef: "other" })).toBe(
			createReviewDraftKey({ ...scope, tab: "uncommitted" }),
		);
	});

	it("retains drafts and errors without subscribers and only notifies their scope", async () => {
		const store = new ReviewDrafts();
		const listener = vi.fn();
		const otherListener = vi.fn();
		const unsubscribe = store.subscribe("a", listener);
		store.subscribe("b", otherListener);
		store.updateComments("a", () => new Map([["one", comment()]]));
		unsubscribe();
		await store.send("a", async () => ({ ok: false, message: "Disconnected" }));
		expect(listener).toHaveBeenCalledTimes(1);
		expect(otherListener).not.toHaveBeenCalled();
		expect(store.get("a").comments.size).toBe(1);
		expect(store.get("a").sendError).toBe("Disconnected");
		expect(store.get("b").comments.size).toBe(0);
	});

	it("synchronously locks duplicates and retains sending across unsubscribe/remount", async () => {
		const store = new ReviewDrafts();
		store.updateComments("a", () => new Map([["one", comment()]]));
		const pending = deferred();
		const send = vi.fn(() => pending.promise);
		const first = store.send("a", send);
		expect(store.get("a").isSending).toBe(true);
		expect(await store.send("a", send)).toBe(false);
		const remountListener = vi.fn();
		store.subscribe("a", remountListener);
		pending.resolve({ ok: true });
		expect(await first).toBe(true);
		expect(send).toHaveBeenCalledTimes(1);
		expect(store.get("a").comments.size).toBe(0);
		expect(remountListener).toHaveBeenCalledTimes(1);
	});

	it("clears only acknowledged snapshot versions, preserving edits, new and empty drafts", async () => {
		const store = new ReviewDrafts();
		const original = comment();
		const unchanged = comment("Unchanged", "b.ts");
		store.updateComments(
			"a",
			() =>
				new Map([
					["one", original],
					["two", unchanged],
					["empty", comment("  ")],
				]),
		);
		const pending = deferred();
		const sent = store.send("a", () => pending.promise);
		const edited = { ...original, comment: "Edited during send" };
		store.updateComments("a", (previous) => new Map(previous).set("one", edited).set("new", comment("New")));
		pending.resolve({ ok: true });
		await sent;
		expect([...store.get("a").comments.keys()]).toEqual(["one", "empty", "new"]);
		expect(store.get("a").comments.get("one")).toBe(edited);
	});

	it.each([
		["Edit", true],
		["Save", false],
		["Cancel", false],
		["legacy editing state", undefined],
	] as const)("acknowledges unchanged content after %s presentation changes", async (_action, editing) => {
		const store = new ReviewDrafts();
		const original = { ...comment(), anchorRevision: "original snapshot", editing: false };
		store.updateComments("a", () => new Map([["one", original]]));
		const pending = deferred();
		const sent = store.send("a", () => pending.promise);
		store.updateComments("a", (previous) => new Map(previous).set("one", { ...original, editing }));
		pending.resolve({ ok: true });
		await sent;
		expect(store.get("a").comments.size).toBe(0);
	});

	it.each([
		{ comment: "New content" },
		{ lineText: "Changed original code" },
		{ anchorRevision: "new snapshot" },
		{ filePath: "other.ts" },
		{ lineNumber: 2 },
		{ variant: "removed" as const },
	])("retains genuine payload or identity changes: %j", async (change) => {
		const store = new ReviewDrafts();
		const original = { ...comment(), anchorRevision: "original snapshot" };
		store.updateComments("a", () => new Map([["one", original]]));
		const pending = deferred();
		const sent = store.send("a", () => pending.promise);
		const changed = { ...original, ...change };
		store.updateComments("a", (previous) => new Map(previous).set("one", changed));
		pending.resolve({ ok: true });
		await sent;
		expect(store.get("a").comments.get("one")).toBe(changed);
	});

	it("acknowledges edit/revert to the same payload but preserves identical newly addressed drafts", async () => {
		const store = new ReviewDrafts();
		const original = { ...comment(), anchorRevision: "original snapshot" };
		store.updateComments("a", () => new Map([["one", original]]));
		const pending = deferred();
		const sent = store.send("a", () => pending.promise);
		store.updateComments("a", (previous) => new Map(previous).set("one", { ...original, comment: "Interim edit" }));
		store.updateComments("a", (previous) =>
			new Map(previous).set("one", { ...original, editing: false }).set("new-address", { ...original }),
		);
		pending.resolve({ ok: true });
		await sent;
		expect([...store.get("a").comments.keys()]).toEqual(["new-address"]);
	});

	it("captures payload values before transport instead of relying on mutable object references", async () => {
		const store = new ReviewDrafts();
		const original = comment();
		store.updateComments("a", () => new Map([["one", original]]));
		const pending = deferred();
		const sent = store.send("a", () => pending.promise);
		original.comment = "Changed after the snapshot";
		pending.resolve({ ok: true });
		await sent;
		expect(store.get("a").comments.get("one")).toBe(original);
	});

	it("completion after navigation updates only the original scope", async () => {
		const store = new ReviewDrafts();
		store.updateComments("a", () => new Map([["one", comment()]]));
		const pending = deferred();
		const sent = store.send("a", () => pending.promise);
		store.updateComments("b", () => new Map([["other", comment("Other task")]]));
		const other = store.get("b");
		pending.resolve({ ok: true });
		await sent;
		expect(store.get("b")).toBe(other);
		expect(store.get("a").comments.size).toBe(0);
	});

	it("retains current drafts on rejection and unknown delivery failures", async () => {
		const store = new ReviewDrafts();
		const original = comment();
		store.updateComments("a", () => new Map([["one", original]]));
		expect(await store.send("a", async () => ({ ok: false, message: "Busy" }))).toBe(false);
		expect(store.get("a").sendError).toBe("Busy");
		expect(
			await store.send("a", async () => {
				throw new Error("Lost connection");
			}),
		).toBe(false);
		expect(store.get("a").sendError).toContain("Delivery could not be confirmed");
		expect(store.get("a").comments.get("one")).toBe(original);
		expect(store.get("a").isSending).toBe(false);
	});

	it("ignores whitespace and sorts all latest nonempty comments by path and line", async () => {
		const store = new ReviewDrafts();
		const send = vi.fn(async (_comments: DiffLineComment[]) => ({ ok: true }));
		store.updateComments("a", () => new Map([["empty", comment("\n ")]]));
		expect(await store.send("a", send)).toBe(false);
		expect(send).not.toHaveBeenCalled();
		store.updateComments("a", (previous) =>
			new Map(previous)
				.set("last", comment("Last", "z.ts", 1))
				.set("second", comment("Second", "a.ts", 4))
				.set("first", comment("First", "a.ts", 2)),
		);
		await store.send("a", send);
		expect(send.mock.calls[0]?.[0]).toEqual([
			comment("First", "a.ts", 2),
			comment("Second", "a.ts", 4),
			comment("Last", "z.ts", 1),
		]);
	});
});
