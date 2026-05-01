import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GitCommitListPanel } from "@/components/git/history/git-commit-list-panel";
import type { RuntimeGitCommit } from "@/runtime/types";

type GitCommitListPanelProps = Parameters<typeof GitCommitListPanel>[0];

function createCommit(index: number): RuntimeGitCommit {
	return {
		hash: `commit-${index}`,
		shortHash: `c${index}`,
		authorName: `Author ${index}`,
		authorEmail: `author-${index}@example.com`,
		date: new Date(Date.now() - index * 60_000).toISOString(),
		message: `Commit message ${index}`,
		parentHashes: index === 0 ? [] : [`commit-${index - 1}`],
		relation: "shared",
	};
}

function createCommits(count: number): RuntimeGitCommit[] {
	return Array.from({ length: count }, (_, index) => createCommit(index));
}

describe("GitCommitListPanel", () => {
	let container: HTMLDivElement;
	let root: Root;
	let previousActEnvironment: boolean | undefined;
	let offsetHeightSpy: ReturnType<typeof vi.spyOn>;
	let offsetWidthSpy: ReturnType<typeof vi.spyOn>;

	beforeEach(() => {
		previousActEnvironment = (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean })
			.IS_REACT_ACT_ENVIRONMENT;
		(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
		offsetHeightSpy = vi
			.spyOn(HTMLDivElement.prototype, "offsetHeight", "get")
			.mockImplementation(function offsetHeight(this: HTMLDivElement) {
				return this.style.overflowY === "auto" ? 150 : 50;
			});
		offsetWidthSpy = vi.spyOn(HTMLDivElement.prototype, "offsetWidth", "get").mockReturnValue(320);
		container = document.createElement("div");
		document.body.appendChild(container);
		root = createRoot(container);
	});

	afterEach(() => {
		act(() => {
			root.unmount();
		});
		offsetHeightSpy.mockRestore();
		offsetWidthSpy.mockRestore();
		container.remove();
		if (previousActEnvironment === undefined) {
			delete (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
		} else {
			(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
				previousActEnvironment;
		}
	});

	function renderPanel(overrides: Partial<GitCommitListPanelProps> = {}): void {
		const commits = overrides.commits ?? createCommits(3);
		const props: GitCommitListPanelProps = {
			commits,
			totalCount: commits.length,
			selectedCommitHash: commits[0]?.hash ?? null,
			isLoading: false,
			isLoadingMore: false,
			canLoadMore: false,
			errorMessage: null,
			refs: [],
			panelWidth: 320,
			onSelectCommit: () => {},
			...overrides,
		};

		root.render(<GitCommitListPanel {...props} />);
	}

	function getScrollContainer(): HTMLDivElement {
		const scrollContainer = container.querySelector("div[tabindex='0']");
		expect(scrollContainer).toBeInstanceOf(HTMLDivElement);
		if (!(scrollContainer instanceof HTMLDivElement)) {
			throw new Error("Expected commit list scroll container.");
		}
		return scrollContainer;
	}

	it("renders fixed-height virtual rows and the end-of-history footer", async () => {
		await act(async () => {
			renderPanel({ commits: createCommits(3), totalCount: 3, canLoadMore: false });
		});

		const rows = Array.from(container.querySelectorAll<HTMLButtonElement>(".kb-git-commit-row"));
		expect(rows).toHaveLength(3);
		for (const row of rows) {
			expect(row.style.height).toBe("50px");
		}
		expect(container.textContent).toContain("End of history");
	});

	it("moves selection with arrow keys when the commit list has focus", async () => {
		const commits = createCommits(4);
		const onSelectCommit = vi.fn();

		await act(async () => {
			renderPanel({
				commits,
				totalCount: commits.length,
				selectedCommitHash: commits[1]?.hash ?? null,
				onSelectCommit,
			});
		});

		const scrollContainer = getScrollContainer();
		scrollContainer.focus();

		await act(async () => {
			scrollContainer.dispatchEvent(
				new KeyboardEvent("keydown", { key: "ArrowDown", code: "ArrowDown", bubbles: true }),
			);
		});

		expect(onSelectCommit).toHaveBeenCalledWith(commits[2]);
	});

	it("calls onLoadMore when the virtual range reaches the end", async () => {
		const commits = createCommits(30);
		const onLoadMore = vi.fn();

		await act(async () => {
			renderPanel({
				commits,
				totalCount: 60,
				canLoadMore: true,
				onLoadMore,
			});
		});

		expect(onLoadMore).not.toHaveBeenCalled();
		const scrollContainer = getScrollContainer();

		await act(async () => {
			Object.defineProperty(scrollContainer, "scrollTop", {
				configurable: true,
				writable: true,
				value: 1_400,
			});
			scrollContainer.dispatchEvent(new Event("scroll", { bubbles: true }));
			await Promise.resolve();
		});

		expect(onLoadMore).toHaveBeenCalledTimes(1);
	});

	it("does not call onLoadMore while the full loading state is active", async () => {
		const commits = createCommits(30);
		const onLoadMore = vi.fn();

		await act(async () => {
			renderPanel({
				commits,
				totalCount: 60,
				isLoading: true,
				canLoadMore: true,
				onLoadMore,
			});
		});

		expect(container.textContent).not.toContain("Commit message");
		const scrollContainer = getScrollContainer();

		await act(async () => {
			Object.defineProperty(scrollContainer, "scrollTop", {
				configurable: true,
				writable: true,
				value: 1_400,
			});
			scrollContainer.dispatchEvent(new Event("scroll", { bubbles: true }));
			await Promise.resolve();
		});

		expect(onLoadMore).not.toHaveBeenCalled();
	});

	it("renders loading and append-error footers inside the commit list", async () => {
		const commits = createCommits(3);
		const onLoadMore = vi.fn();

		await act(async () => {
			renderPanel({
				commits,
				totalCount: 8,
				canLoadMore: true,
				isLoadingMore: true,
				onLoadMore,
			});
		});

		expect(container.textContent).toContain("Loading more commits...");

		await act(async () => {
			renderPanel({
				commits,
				totalCount: 8,
				canLoadMore: true,
				errorMessage: "Network unavailable",
				onLoadMore,
			});
		});

		expect(container.textContent).toContain("Network unavailable");
		expect(container.textContent).not.toContain("Could not load commits");

		const retryButton = Array.from(container.querySelectorAll("button")).find(
			(button) => button.textContent === "Retry",
		);
		expect(retryButton).toBeInstanceOf(HTMLButtonElement);
		await act(async () => {
			retryButton?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
		});

		expect(onLoadMore).toHaveBeenCalledTimes(1);
	});
});
