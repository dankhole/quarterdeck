import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RuntimeStateStreamTaskReadyForReviewMessage } from "@/runtime/types";
import { useReviewReadyNotifications } from "./use-review-ready-notifications";

describe("review-ready document title", () => {
	let root: Root;
	let originalTitle: string;
	function Harness({
		projectName,
		activeProjectId = "p1",
		event = null,
	}: {
		projectName: string | null;
		activeProjectId?: string | null;
		event?: RuntimeStateStreamTaskReadyForReviewMessage | null;
	}) {
		useReviewReadyNotifications({ activeProjectId, projectName, latestTaskReadyForReview: event });
		return null;
	}
	beforeEach(() => {
		originalTitle = document.title;
		root = createRoot(document.createElement("div"));
		vi.spyOn(document, "hasFocus").mockReturnValue(false);
	});
	afterEach(() => {
		act(() => root.unmount());
		vi.restoreAllMocks();
		document.title = originalTitle;
	});

	it("updates a same-ID display name and retains unread notification counts", () => {
		act(() => root.render(<Harness projectName="project" />));
		expect(document.title).toBe("project");
		const event: RuntimeStateStreamTaskReadyForReviewMessage = {
			type: "task_ready_for_review",
			projectId: "p1",
			taskId: "task-1",
			triggeredAt: Date.parse("2026-09-30T12:00:00.000Z"),
		};
		act(() => root.render(<Harness projectName="project" event={event} />));
		expect(document.title).toBe("(1) project");
		act(() => root.render(<Harness projectName="Folder Recovery Demo" event={event} />));
		expect(document.title).toBe("(1) Folder Recovery Demo");
		act(() => root.render(<Harness projectName="project" event={event} />));
		expect(document.title).toBe("(1) project");
	});

	it("uses the saved project name without requiring a folder path and clears it when no project is selected", () => {
		act(() => root.render(<Harness projectName="Folder Recovery Demo" />));
		expect(document.title).toBe("Folder Recovery Demo");
		act(() => root.render(<Harness projectName={null} activeProjectId={null} />));
		expect(document.title).toBe("quarterdeck");
	});
});
