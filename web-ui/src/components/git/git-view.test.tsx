import { act, type ComponentProps } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DiffViewerPanel } from "@/components/git/panels/diff-viewer-panel";
import type { DiffLineComment } from "@/components/git/panels/diff-viewer-utils";
import { TooltipProvider } from "@/components/ui/tooltip";
import { diffCodeNavigationUnavailableReason } from "@/hooks/git/diff-code-navigation";
import { createReviewDocument } from "@/hooks/git/review-document";
import { GitView } from "./git-view";

const mocks = vi.hoisted(() => ({
	open: vi.fn(),
	toast: vi.fn(),
	tab: "compare",
	sourceRef: "feature",
	targetRef: "main",
	includeUncommitted: true,
	viewer: vi.fn(),
	comments: new Map<string, DiffLineComment>(),
	hasNoChanges: false,
	isChangesPending: false,
}));
vi.mock("@/components/compare-window/open-compare-window", () => ({ openCompareWindow: mocks.open }));
vi.mock("@/components/app-toaster", () => ({ showAppToast: mocks.toast }));
vi.mock("@/components/git/git-view-compare-bar", () => ({ CompareBar: () => null }));
vi.mock("@/components/git/panels/diff-viewer-panel", () => ({
	DiffViewerPanel: (props: ComponentProps<typeof DiffViewerPanel>) => {
		mocks.viewer(props);
		return null;
	},
}));
vi.mock("@/hooks/git/use-git-view", () => ({
	useGitView: () => ({
		repositoryScope: { projectId: "project", taskId: null },
		activeTab: mocks.tab,
		setActiveTab: vi.fn(),
		fileTreeVisible: false,
		setFileTreeVisible: vi.fn(),
		selectedPath: "src/app.ts",
		conflictResolution: { isActive: false },
		compare: {
			sourceRef: mocks.sourceRef,
			targetRef: mocks.targetRef,
			includeUncommitted: mocks.includeUncommitted,
			threeDotDiff: false,
		},
		hasCompareRefs: Boolean(mocks.sourceRef && mocks.targetRef),
		hasNoChanges: mocks.hasNoChanges,
		isChangesPending: mocks.isChangesPending,
		diffComments: mocks.comments,
		reviewDraftKey: "window-scoped-review",
		enrichedFiles: [],
		isRuntimeAvailable: true,
	}),
}));

describe("GitView Compare pop-out", () => {
	let container: HTMLDivElement;
	let root: Root;
	beforeEach(() => {
		(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
		container = document.createElement("div");
		document.body.appendChild(container);
		root = createRoot(container);
		vi.clearAllMocks();
		mocks.tab = "compare";
		mocks.sourceRef = "feature";
		mocks.targetRef = "main";
		mocks.includeUncommitted = true;
		mocks.comments = new Map();
		mocks.hasNoChanges = false;
		mocks.isChangesPending = false;
		mocks.open.mockResolvedValue(undefined);
	});
	afterEach(() => {
		act(() => root.unmount());
		container.remove();
	});
	async function render() {
		await act(async () =>
			root.render(
				<TooltipProvider>
					<GitView currentProjectId="project" selectedCard={null} />
				</TooltipProvider>,
			),
		);
	}
	it("captures the current project, refs, flags and selected path", async () => {
		await render();
		await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="Pop out Compare"]')?.click());
		expect(mocks.open).toHaveBeenCalledWith({
			projectId: "project",
			taskId: null,
			sourceRef: "feature",
			targetRef: "main",
			includeUncommitted: true,
			threeDotDiff: false,
			selectedPath: "src/app.ts",
		});
	});
	it("disables opening until both refs are selected", async () => {
		mocks.targetRef = "";
		await render();
		expect(container.querySelector<HTMLButtonElement>('[aria-label="Pop out Compare"]')?.disabled).toBe(true);
	});
	it("does not expose the button in Uncommitted", async () => {
		mocks.tab = "uncommitted";
		await render();
		expect(container.querySelector('[aria-label="Pop out Compare"]')).toBeNull();
	});
	it("distinguishes a committed WORKTREE branch from live Compare content and Uncommitted", async () => {
		mocks.sourceRef = "WORKTREE";
		const currentDocument = () => {
			const props = mocks.viewer.mock.calls.at(-1)?.[0] as ComponentProps<typeof DiffViewerPanel>;
			return createReviewDocument(
				props.reviewScope,
				{ path: "src/app.ts" },
				{ kind: "text", oldText: "old()", newText: "identical()" },
			);
		};
		await render();
		const live = currentDocument();
		expect(live.revisions).toMatchObject({ kind: "compare", head: "WORKTREE", headSource: "live-worktree" });
		expect(diffCodeNavigationUnavailableReason(live)).toBeNull();
		mocks.includeUncommitted = false;
		await render();
		const historical = currentDocument();
		expect(historical.revisions).toMatchObject({ kind: "compare", head: "WORKTREE", headSource: "revision" });
		expect(diffCodeNavigationUnavailableReason(historical)).toContain("historical");
		expect(historical.key).not.toBe(live.key);
		mocks.tab = "uncommitted";
		await render();
		const uncommitted = currentDocument();
		expect(uncommitted.revisions).toMatchObject({ kind: "working-copy", headSource: "live-worktree" });
		expect(diffCodeNavigationUnavailableReason(uncommitted)).toBeNull();
	});
	it.each(["empty", "missing-refs", "pending"] as const)(
		"keeps drafts and their owner key reachable when %s",
		async (state) => {
			mocks.comments.set("a.ts:added:1", {
				filePath: "a.ts",
				lineNumber: 1,
				lineText: "old anchor",
				variant: "added",
				comment: "Retain me",
				editing: false,
			});
			mocks.hasNoChanges = state === "empty";
			mocks.isChangesPending = state === "pending";
			if (state === "missing-refs") mocks.targetRef = "";
			await render();
			expect(mocks.viewer).toHaveBeenCalled();
			const props = mocks.viewer.mock.calls.at(-1)?.[0] as ComponentProps<typeof DiffViewerPanel>;
			expect(props.comments).toBe(mocks.comments);
			expect(props.reviewDraftKey).toBe("window-scoped-review");
			expect(props.projectFiles).toEqual(state === "empty" ? [] : null);
		},
	);
	it("reports opening failure without leaving the button busy", async () => {
		mocks.open.mockRejectedValue(new Error("Allow popups"));
		await render();
		const button = container.querySelector<HTMLButtonElement>('[aria-label="Pop out Compare"]');
		await act(async () => button?.click());
		expect(mocks.toast).toHaveBeenCalledWith(expect.objectContaining({ message: "Allow popups", intent: "danger" }));
		expect(button?.disabled).toBe(false);
	});
});
