import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GitHistoryView } from "@/components/git/git-history-view";
import type { UseGitHistoryDataResult } from "@/components/git/history/use-git-history-data";
import type { RuntimeGitCommit } from "@/runtime/types";
import { LocalStorageKey } from "@/storage/local-storage-store";

const mockGitRefsPanel = vi.fn((_props: { panelWidth: number }) => <div data-testid="git-refs-panel" />);
const mockGitCommitListPanel = vi.fn((_props: { panelWidth: number }) => <div data-testid="git-commit-list-panel" />);
const cherryPickMutate = vi.hoisted(() => vi.fn(async () => ({ ok: true })));

vi.mock("@/runtime/trpc-client", () => ({
	getRuntimeTrpcClient: () => ({ project: { cherryPickCommit: { mutate: cherryPickMutate } } }),
}));

vi.mock("@/components/app-toaster", () => ({ showAppToast: vi.fn() }));

vi.mock("@/components/git/branch-select-dropdown", () => ({
	BranchSelectDropdown: ({
		options,
		onSelect,
	}: {
		options: { value: string }[];
		onSelect: (branch: string) => void;
	}) => (
		<button
			type="button"
			onClick={() => {
				const option = options[0];
				if (option) onSelect(option.value);
			}}
		>
			Choose landing branch
		</button>
	),
}));

vi.mock("@/components/git/history/git-refs-panel", () => ({
	GitRefsPanel: (props: { panelWidth: number }) => mockGitRefsPanel(props),
}));

vi.mock("@/components/git/history/git-commit-list-panel", () => ({
	GitCommitListPanel: (props: { panelWidth: number }) => mockGitCommitListPanel(props),
}));

vi.mock("@/components/git/history/git-commit-diff-panel", () => ({
	GitCommitDiffPanel: ({ headerContent }: { headerContent?: ReactNode }) => (
		<div data-testid="git-commit-diff-panel">{headerContent}</div>
	),
}));

vi.mock("@/resize/layout-customizations", () => ({
	useLayoutResetEffect: () => {},
}));

function createGitHistory(): UseGitHistoryDataResult {
	return {
		viewMode: "working-copy",
		refs: [],
		activeRef: null,
		refsErrorMessage: null,
		isRefsLoading: false,
		workingCopyFileCount: 0,
		hasWorkingCopy: false,
		commits: [],
		totalCommitCount: 0,
		selectedCommitHash: null,
		selectedCommit: null,
		isLogLoading: false,
		isLoadingMoreCommits: false,
		logErrorMessage: null,
		diffSource: null,
		isDiffLoading: false,
		diffErrorMessage: null,
		selectedDiffPath: null,
		selectWorkingCopy: () => {},
		selectRef: () => {},
		selectCommit: () => {},
		selectDiffPath: () => {},
		loadMoreCommits: () => {},
		refresh: () => {},
	};
}

describe("GitHistoryView", () => {
	let container: HTMLDivElement;
	let root: Root;
	let previousActEnvironment: boolean | undefined;
	let currentOffsetWidth: number;
	let offsetWidthSpy: ReturnType<typeof vi.spyOn>;

	beforeEach(() => {
		previousActEnvironment = (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean })
			.IS_REACT_ACT_ENVIRONMENT;
		(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
		currentOffsetWidth = 900;
		offsetWidthSpy = vi.spyOn(HTMLDivElement.prototype, "offsetWidth", "get").mockImplementation(function offsetWidth(
			this: HTMLDivElement,
		) {
			if (this.dataset.testid === "git-refs-panel") {
				return 0;
			}
			return currentOffsetWidth;
		});
		container = document.createElement("div");
		document.body.appendChild(container);
		root = createRoot(container);
		window.localStorage.clear();
		mockGitRefsPanel.mockClear();
		mockGitCommitListPanel.mockClear();
		cherryPickMutate.mockClear();
	});

	afterEach(() => {
		act(() => {
			root.unmount();
		});
		offsetWidthSpy.mockRestore();
		container.remove();
		window.localStorage.clear();
		mockGitRefsPanel.mockClear();
		mockGitCommitListPanel.mockClear();
		cherryPickMutate.mockClear();
		if (previousActEnvironment === undefined) {
			delete (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
		} else {
			(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
				previousActEnvironment;
		}
	});

	it("clamps displayed widths without overwriting persisted preferences on viewport resize", async () => {
		window.localStorage.setItem(LocalStorageKey.GitHistoryRefsPanelWidth, "400");
		window.localStorage.setItem(LocalStorageKey.GitHistoryCommitsPanelWidth, "500");

		await act(async () => {
			root.render(<GitHistoryView projectId="project-1" gitHistory={createGitHistory()} />);
		});

		expect(mockGitRefsPanel).toHaveBeenCalled();
		expect(mockGitCommitListPanel).toHaveBeenCalled();
		expect(mockGitRefsPanel.mock.calls.at(-1)?.[0]).toMatchObject({ panelWidth: 298 });
		expect(mockGitCommitListPanel.mock.calls.at(-1)?.[0]).toMatchObject({ panelWidth: 260 });
		expect(window.localStorage.getItem(LocalStorageKey.GitHistoryRefsPanelWidth)).toBe("400");
		expect(window.localStorage.getItem(LocalStorageKey.GitHistoryCommitsPanelWidth)).toBe("500");

		currentOffsetWidth = 1400;
		await act(async () => {
			window.dispatchEvent(new Event("resize"));
		});

		expect(mockGitRefsPanel.mock.calls.at(-1)?.[0]).toMatchObject({ panelWidth: 400 });
		expect(mockGitCommitListPanel.mock.calls.at(-1)?.[0]).toMatchObject({ panelWidth: 500 });
		expect(window.localStorage.getItem(LocalStorageKey.GitHistoryRefsPanelWidth)).toBe("400");
		expect(window.localStorage.getItem(LocalStorageKey.GitHistoryCommitsPanelWidth)).toBe("500");
	});

	it.each([null, { taskId: "task-a", baseRef: "main" }])(
		"requires confirmation each time a commit is landed (task scope: %j)",
		async (taskScope) => {
			const commit: RuntimeGitCommit = {
				hash: "abc123456789",
				shortHash: "abc1234",
				authorName: "Test Author",
				authorEmail: "author@example.test",
				date: "2026-01-01T00:00:00.000Z",
				message: "A change to land",
				parentHashes: ["parent123"],
			};
			const gitHistory: UseGitHistoryDataResult = {
				...createGitHistory(),
				viewMode: "commit",
				selectedCommit: commit,
				selectedCommitHash: commit.hash,
				refs: [{ name: "release", type: "branch", hash: "release123", isHead: false }],
				refresh: vi.fn(),
			};
			await act(async () => {
				root.render(<GitHistoryView projectId="project-1" gitHistory={gitHistory} taskScope={taskScope} />);
			});

			async function clickButton(label: string): Promise<void> {
				const button = Array.from(document.querySelectorAll("button")).find((item) => item.textContent === label);
				expect(button).toBeDefined();
				await act(async () => button?.click());
			}

			await clickButton("Choose landing branch");
			expect(document.querySelector('[role="alertdialog"]')?.textContent).toContain("Land commit on branch");
			expect(cherryPickMutate).not.toHaveBeenCalled();

			await clickButton("Cancel");
			expect(document.querySelector('[role="alertdialog"]')).toBeNull();
			expect(cherryPickMutate).not.toHaveBeenCalled();

			await clickButton("Choose landing branch");
			expect(cherryPickMutate).not.toHaveBeenCalled();
			await clickButton("Land commit");

			expect(cherryPickMutate).toHaveBeenCalledExactlyOnceWith({
				commitHash: commit.hash,
				targetBranch: "release",
				taskScope,
			});
			expect(document.querySelector('[role="alertdialog"]')).toBeNull();
			expect(gitHistory.refresh).toHaveBeenCalledWith({ background: true });

			await clickButton("Choose landing branch");
			expect(document.querySelector('[role="alertdialog"]')).not.toBeNull();
			await clickButton("Cancel");
			expect(document.querySelector('[role="alertdialog"]')).toBeNull();
			expect(cherryPickMutate).toHaveBeenCalledTimes(1);
		},
	);
});
