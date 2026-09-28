import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	clearCachedFileEditorTabs,
	getCachedFileEditorTabs,
	getFileEditorDrafts,
	registerFileEditorScope,
	setCachedFileEditorTabs,
} from "@/hooks/git/file-editor-cache";
import { createFileEditorTab } from "@/hooks/git/file-editor-workspace";
import { type UseProjectNavigationResult, useProjectNavigation } from "./use-project-navigation";

const remove = vi.hoisted(() => vi.fn());
vi.mock("@/runtime/trpc-client", () => ({
	getRuntimeTrpcClient: () => ({ projects: { remove: { mutate: remove } } }),
}));
vi.mock("@/components/app-toaster", () => ({ notifyError: vi.fn(), showAppToast: vi.fn() }));
vi.mock("@/runtime/use-runtime-state-stream", () => ({
	useRuntimeStateStream: () => ({
		currentProjectId: "p1",
		projects: [
			{
				id: "p1",
				path: "/tmp/project",
				name: "project",
				boardRevision: 1,
				taskCounts: { in_progress: 0, review: 0, trash: 0 },
			},
		],
		projectState: null,
		projectMetadata: null,
		notificationProjects: {},
		latestTaskReadyForReview: null,
		latestTaskTitleUpdate: null,
		latestTaskBaseRefUpdate: null,
		streamError: null,
		isRuntimeDisconnected: false,
		hasReceivedSnapshot: true,
	}),
}));

afterEach(() => {
	clearCachedFileEditorTabs();
	vi.clearAllMocks();
});

describe("project removal editor protection", () => {
	it.each(["dirty", "clean", "failed"] as const)("handles %s hidden tabs before project removal", async (mode) => {
		registerFileEditorScope("hidden", { projectId: "p1", taskId: null, rootPath: "/tmp/project" });
		const tab = createFileEditorTab("app.ts", {
			content: "saved",
			contentHash: "hash",
			language: "typescript",
			binary: false,
			truncated: false,
			size: 5,
		});
		setCachedFileEditorTabs("hidden", [{ ...tab, value: mode === "dirty" ? "draft" : tab.value }]);
		remove.mockResolvedValue({ ok: mode !== "failed", error: "Could not remove" });
		let navigation: UseProjectNavigationResult | null = null;
		function Harness() {
			navigation = useProjectNavigation({ onProjectSwitchStart: () => {} });
			return null;
		}
		const container = document.createElement("div");
		const root = createRoot(container);
		try {
			await act(async () => {
				root.render(<Harness />);
			});
			await act(async () => {
				if (!navigation) throw new Error("No navigation");
				await navigation.handleRemoveProject("p1");
			});
			if (mode === "dirty") {
				expect(remove).not.toHaveBeenCalled();
				expect(getFileEditorDrafts()[0]?.tab.value).toBe("draft");
			} else {
				expect(remove).toHaveBeenCalledWith({ projectId: "p1" });
				expect(getCachedFileEditorTabs("hidden")).toHaveLength(mode === "clean" ? 0 : 1);
			}
		} finally {
			await act(async () => root.unmount());
		}
	});
});
