import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resolveCheckoutDialogState } from "@/components/git/panels";
import type { RuntimeTaskRepositoryInfoResponse } from "@/runtime/types";
import {
	clearTaskRepositoryInfo,
	resetProjectMetadataStore,
	setProjectMetadataScope,
	setProjectPath,
	setTaskRepositoryInfo,
} from "@/stores/project-metadata-store";
import type { BoardData } from "@/types";
import { useBranchActions } from "./use-branch-actions";
import { useGitViewCompare } from "./use-git-view-compare";

vi.mock("@/runtime/use-trpc-query", () => ({
	useTrpcQuery: () => ({ data: null, isLoading: false, refetch: vi.fn() }),
}));

vi.mock("@/components/app-toaster", () => ({ showAppToast: vi.fn() }));

const board: BoardData = {
	columns: [
		{
			id: "review",
			title: "Review",
			cards: [
				{
					id: "restored-task",
					title: "Restored task",
					prompt: "Task",
					baseRef: "main",
					branch: "original-branch",
					useWorktree: true,
					createdAt: 1,
					updatedAt: 1,
				},
			],
		},
	],
};

const attached: RuntimeTaskRepositoryInfoResponse = {
	taskId: "restored-task",
	path: "/worktrees/restored-task",
	exists: true,
	baseRef: "main",
	branch: "original-branch",
	isDetached: false,
	headCommit: "abc123",
};

interface HarnessProps {
	projectId: string;
	onBranches: (branches: Map<string, string>) => void;
}

function BranchActionsHarness({ projectId, onBranches }: HarnessProps): null {
	const { worktreeBranches } = useBranchActions({
		projectId,
		board,
		selectBranchView: () => {},
		homeGitSummary: null,
	});
	onBranches(worktreeBranches);
	return null;
}

function CompareHarness({ projectId, onBranches }: HarnessProps): null {
	const { worktreeBranches } = useGitViewCompare({
		currentProjectId: projectId,
		board,
		selectedCard: null,
		homeGitSummary: null,
		isActive: false,
	});
	onBranches(worktreeBranches);
	return null;
}

describe.each([
	{ name: "branch actions", Harness: BranchActionsHarness },
	{ name: "Git compare", Harness: CompareHarness },
])("$name observed worktree branches", ({ Harness }) => {
	let root: Root;
	let branches: Map<string, string>;

	beforeEach(() => {
		vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
		resetProjectMetadataStore("project-a");
		setProjectPath("project-a", "/repo/a");
		root = createRoot(document.createElement("div"));
	});

	afterEach(() => {
		act(() => root.unmount());
		resetProjectMetadataStore();
		vi.unstubAllGlobals();
	});

	function render(projectId = "project-a"): void {
		act(() => {
			root.render(
				<Harness
					projectId={projectId}
					onBranches={(value) => {
						branches = value;
					}}
				/>,
			);
		});
	}

	function checkout(currentBranch: string | null = "main") {
		return resolveCheckoutDialogState({
			branch: "original-branch",
			scope: "home",
			currentBranch,
			dirtyWorkingTree: false,
			worktreeBranches: branches,
			skipTaskConfirmation: false,
			skipHomeConfirmation: false,
		});
	}

	it("permits detached restores and unknown branch hints while blocking observed attachments", () => {
		render();
		expect(checkout()).toMatchObject({ type: "confirm" });
		act(() => {
			setTaskRepositoryInfo("project-a", attached);
		});
		expect(checkout()).toMatchObject({ type: "blocked", taskTitle: "Restored task" });
		// The current checkout remains selectable rather than blocking itself.
		expect(checkout("original-branch")).toBe("skip");
		act(() => {
			setTaskRepositoryInfo("project-a", { ...attached, isDetached: true, branch: null });
		});
		expect(branches.size).toBe(0);
		expect(checkout()).toMatchObject({ type: "confirm" });
		act(() => {
			clearTaskRepositoryInfo("project-a", attached.taskId);
		});
		expect(checkout()).toMatchObject({ type: "confirm" });
	});

	it("drops blockers immediately on project changes and same-project relocation", () => {
		setTaskRepositoryInfo("project-a", attached);
		render();
		expect(branches.has("original-branch")).toBe(true);
		render("project-b");
		expect(branches.size).toBe(0);
		act(() => {
			setProjectMetadataScope("project-b");
			setProjectPath("project-b", "/repo/b");
			setTaskRepositoryInfo("project-b", { ...attached, branch: "project-b-branch" });
		});
		expect([...branches]).toEqual([["project-b-branch", "Restored task"]]);
		act(() => {
			setProjectPath("project-b", "/repo/b-moved");
		});
		expect(branches.size).toBe(0);
	});
});
