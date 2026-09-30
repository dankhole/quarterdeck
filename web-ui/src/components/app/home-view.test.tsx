import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HomeView } from "@/components/app/home-view";
import { BoardReplyDrafts } from "@/state/board-reply-drafts";

const mocks = vi.hoisted(() => ({
	mainView: "home",
	requestLocate: vi.fn(),
	checkAvailability: vi.fn(),
	pendingProjectId: null as string | null,
	boardProjectId: "saved-project",
	isRuntimeDisconnected: false,
}));

vi.mock("@/providers/project-provider", () => ({
	useProjectNavigationContext: () => ({
		currentProjectId: "saved-project",
		currentProjectAvailability: { status: "unavailable", reason: "missing" },
		isRuntimeDisconnected: mocks.isRuntimeDisconnected,
		hasNoProjects: false,
	}),
	useProjectSyncContext: () => ({
		boardProjectId: mocks.boardProjectId,
		projectPath: "/missing/project",
		projectGit: null,
	}),
}));
vi.mock("@/providers/project-management-context", () => ({ useProjectManagementContext: () => mocks }));
vi.mock("@/providers/project-runtime-provider", () => ({ useProjectRuntimeContext: () => ({}) }));
vi.mock("@/providers/board-provider", () => ({
	useBoardContext: () => ({
		board: { columns: [] },
		sessions: {},
		replyDrafts: new BoardReplyDrafts(),
		selectedTaskId: null,
	}),
}));
vi.mock("@/providers/git-provider", () => ({
	useGitContext: () => ({ homeFileBrowserData: { searchScope: null } }),
}));
vi.mock("@/providers/interactions-provider", () => ({ useInteractionsContext: () => ({}) }));
vi.mock("@/providers/terminal-provider", () => ({
	useTerminalContext: () => ({ showHomeBottomTerminal: true }),
}));
vi.mock("@/providers/surface-navigation-provider", () => ({
	useSurfaceNavigationContext: () => ({ mainView: mocks.mainView, setActiveFileSearchScope: () => {} }),
}));
vi.mock("@/components/app/top-bar", () => ({ GitBranchStatusControl: () => null }));
vi.mock("@/components/board", () => ({
	QuarterdeckBoard: ({ readOnly }: { readOnly: boolean }) => (
		<div data-read-only={String(readOnly)}>Saved task board</div>
	),
}));
vi.mock("@/components/git", () => ({
	ConflictBanner: () => <div>Conflict banner</div>,
	FilesView: () => <div>Live files</div>,
	GitView: () => <div>Live Git</div>,
	GitHistoryView: () => <div>Git history</div>,
}));
vi.mock("@/components/git/panels", () => ({
	BranchPillTrigger: () => null,
	BranchSelectorPopover: () => null,
	ScopeBar: () => null,
}));
vi.mock("@/components/terminal", () => ({ ShellTerminalPanel: () => <div>Live shell</div> }));

describe("HomeView unavailable project", () => {
	let container: HTMLDivElement;
	let root: Root;
	beforeEach(() => {
		(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
		mocks.pendingProjectId = null;
		mocks.boardProjectId = "saved-project";
		mocks.isRuntimeDisconnected = false;
		mocks.requestLocate.mockReset();
		mocks.checkAvailability.mockReset();
		container = document.createElement("div");
		document.body.appendChild(container);
		root = createRoot(container);
	});
	afterEach(async () => {
		await act(async () => root.unmount());
		container.remove();
	});

	it.each(["files", "git", "home"])(
		"shows the preserved board from %s and offers recovery actions",
		async (mainView) => {
			mocks.mainView = mainView;
			await act(async () =>
				root.render(
					<HomeView
						topBar={<div>Top bar</div>}
						shouldShowProjectLoadingState
						editingTaskId={null}
						inlineTaskEditor={undefined}
						handleOpenEditTask={() => {}}
						homeGitSummary={null}
					/>,
				),
			);
			expect(container.textContent).toContain("Folder unavailable");
			expect(container.textContent).toContain("Your saved tasks and session history are preserved");
			expect(container.textContent).toContain("/missing/project");
			expect(container.querySelector('[data-read-only="true"]')?.textContent).toBe("Saved task board");
			expect(container.textContent).not.toMatch(/Live files|Live Git|Live shell|Conflict banner/);
			const buttons = [...container.querySelectorAll("button")];
			await act(async () => {
				buttons.find((button) => button.textContent === "Locate folder…")!.click();
				buttons.find((button) => button.textContent === "Check again")!.click();
			});
			expect(mocks.requestLocate).toHaveBeenCalledWith("saved-project");
			expect(mocks.checkAvailability).toHaveBeenCalledWith("saved-project");
		},
	);

	it("disables folder recovery actions while the runtime is disconnected", async () => {
		mocks.isRuntimeDisconnected = true;
		await act(async () =>
			root.render(
				<HomeView
					topBar={null}
					shouldShowProjectLoadingState={false}
					editingTaskId={null}
					inlineTaskEditor={undefined}
					handleOpenEditTask={() => {}}
					homeGitSummary={null}
				/>,
			),
		);
		const buttons = [...container.querySelectorAll("button")];
		expect(buttons).toHaveLength(2);
		await act(async () => {
			for (const button of buttons) {
				expect(button.disabled).toBe(true);
				button.click();
			}
		});
		expect(mocks.requestLocate).not.toHaveBeenCalled();
		expect(mocks.checkAvailability).not.toHaveBeenCalled();
	});

	it("waits for the correct saved board during a switch to an unavailable project", async () => {
		mocks.boardProjectId = "previous-project";
		await act(async () =>
			root.render(
				<HomeView
					topBar={null}
					shouldShowProjectLoadingState
					editingTaskId={null}
					inlineTaskEditor={undefined}
					handleOpenEditTask={() => {}}
					homeGitSummary={null}
				/>,
			),
		);
		expect(container.textContent).not.toContain("Saved task board");
	});
});
