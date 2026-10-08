// @vitest-environment node

import { describe, expect, it, vi } from "vitest";
import { BoardReplyDrafts } from "@/state/board-reply-drafts";

describe("board reply drafts", () => {
	it("isolates drafts and subscriptions and retains failed sends across remounts", async () => {
		const drafts = new BoardReplyDrafts();
		const a = vi.fn();
		const b = vi.fn();
		const unsubscribe = drafts.subscribe("project-a/task", a);
		drafts.subscribe("project-b/task", b);
		drafts.edit("project-a/task", "Please check the narrow layout.");
		expect(a).toHaveBeenCalledOnce();
		expect(b).not.toHaveBeenCalled();
		unsubscribe();
		await drafts.send("project-a/task", async () => ({ ok: false, message: "Session replaced" }));
		expect(drafts.get("project-a/task")).toEqual({
			text: "Please check the narrow layout.",
			sending: false,
			error: "Session replaced",
		});
		expect(drafts.get("project-b/task").text).toBe("");
	});
	it("prevents double submission and clears only after confirmed success", async () => {
		const drafts = new BoardReplyDrafts();
		drafts.edit("task", "Continue");
		let finish!: (result: { ok: boolean }) => void;
		const submit = vi.fn(
			() =>
				new Promise<{ ok: boolean }>((resolve) => {
					finish = resolve;
				}),
		);
		const pending = drafts.send("task", submit);
		await drafts.send("task", submit);
		drafts.edit("task", "Changed while sending");
		expect(submit).toHaveBeenCalledOnce();
		expect(drafts.get("task").text).toBe("Continue");
		finish({ ok: true });
		await pending;
		expect(drafts.get("task")).toEqual({ text: "", sending: false, error: null });
	});
});
