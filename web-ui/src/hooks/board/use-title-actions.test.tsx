import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { showAppToast } from "@/components/app-toaster";
import { type UseTitleActionsResult, useTitleActions } from "@/hooks/board/use-title-actions";

const mutations = vi.hoisted(() => ({ regenerate: vi.fn(), update: vi.fn() }));
vi.mock("@/runtime/trpc-client", () => ({
	getRuntimeTrpcClient: () => ({
		project: {
			regenerateTaskTitle: { mutate: mutations.regenerate },
			updateTaskTitle: { mutate: mutations.update },
		},
	}),
}));
vi.mock("@/components/app-toaster", () => ({ showAppToast: vi.fn() }));

describe("task title action errors", () => {
	let root: Root;
	let actions: UseTitleActionsResult;

	beforeEach(async () => {
		vi.resetAllMocks();
		vi.spyOn(console, "warn").mockImplementation(() => {});
		vi.spyOn(console, "error").mockImplementation(() => {});
		root = createRoot(document.createElement("div"));
		function Harness() {
			actions = useTitleActions({ currentProjectId: "project-1" });
			return null;
		}
		await act(async () => root.render(<Harness />));
	});

	afterEach(async () => {
		await act(async () => root.unmount());
		vi.restoreAllMocks();
	});

	it("shows the runtime's safe, actionable model failure", async () => {
		const error = "Could not generate a task title. Check text-generation settings and try again.";
		mutations.regenerate.mockResolvedValue({ ok: false, error });
		await act(async () => actions.handleRegenerateTitleTask("task-1"));
		expect(mutations.regenerate).toHaveBeenCalledExactlyOnceWith({ taskId: "task-1" });
		expect(showAppToast).toHaveBeenCalledExactlyOnceWith({ intent: "danger", message: error });
	});

	it("retains the fallback message when the runtime returns no error detail", async () => {
		mutations.regenerate.mockResolvedValue({ ok: false });
		await act(async () => actions.handleRegenerateTitleTask("task-1"));
		expect(showAppToast).toHaveBeenCalledExactlyOnceWith({ intent: "danger", message: "Could not regenerate title" });
	});

	it("does not toast a successful regeneration", async () => {
		mutations.regenerate.mockResolvedValue({ ok: true });
		await act(async () => actions.handleRegenerateTitleTask("task-1"));
		expect(showAppToast).not.toHaveBeenCalled();
	});

	it("does not expose arbitrary transport exception details", async () => {
		mutations.regenerate.mockRejectedValue(new Error("private provider response"));
		await act(async () => actions.handleRegenerateTitleTask("task-1"));
		expect(showAppToast).toHaveBeenCalledExactlyOnceWith({ intent: "danger", message: "Could not regenerate title" });
	});

	it("notifies manual title updates rejected without throwing", async () => {
		mutations.update.mockResolvedValue({ ok: false });
		await act(async () => actions.handleUpdateTaskTitle("task-1", "New title"));
		expect(showAppToast).toHaveBeenCalledExactlyOnceWith({ intent: "danger", message: "Could not update title" });
	});

	it("does not toast successful manual title updates", async () => {
		mutations.update.mockResolvedValue({ ok: true });
		await act(async () => actions.handleUpdateTaskTitle("task-1", "New title"));
		expect(showAppToast).not.toHaveBeenCalled();
	});

	it("also notifies failed manual title updates", async () => {
		mutations.update.mockRejectedValue(new Error("private title"));
		await act(async () => actions.handleUpdateTaskTitle("task-1", "New title"));
		expect(showAppToast).toHaveBeenCalledExactlyOnceWith({ intent: "danger", message: "Could not update title" });
	});
});
