import { act, createElement, useEffect } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { UseCommitPanelResult } from "@/hooks/git/use-commit-panel";

// ---------------------------------------------------------------------------
// Mocks — hoisted so they are available before any imports run.
// ---------------------------------------------------------------------------

const useRuntimeProjectChangesMock = vi.hoisted(() =>
	vi.fn(() => ({
		changes: null as {
			files: Array<{
				path: string;
				status: string;
				additions: number;
				deletions: number;
				oldText: string | null;
				newText: string | null;
			}>;
		} | null,
		isLoading: false,
	})),
);

vi.mock("@/runtime/use-runtime-project-changes", () => ({
	useRuntimeProjectChanges: useRuntimeProjectChangesMock,
}));

const useHomeGitSummaryValueMock = vi.hoisted(() =>
	vi.fn(() => ({ currentBranch: "main" }) as { currentBranch: string | null } | null),
);

const useTaskProjectSnapshotValueMock = vi.hoisted(() =>
	vi.fn(() => null as { branch: string | null; isDetached: boolean } | null),
);

vi.mock("@/stores/project-metadata-store", () => ({
	useTaskProjectStateVersionValue: () => 0,
	useHomeGitStateVersionValue: () => 0,
	useHomeGitSummaryValue: useHomeGitSummaryValueMock,
	useTaskProjectSnapshotValue: useTaskProjectSnapshotValueMock,
}));

const commitMutateMock = vi.hoisted(() =>
	vi.fn(
		async () =>
			({ ok: true }) as { ok: boolean; pushOk?: boolean; commitHash?: string; error?: string; pushError?: string },
	),
);
const discardGitChangesMutateMock = vi.hoisted(() => vi.fn(async () => ({ ok: true })));
const discardFileMutateMock = vi.hoisted(() => vi.fn(async () => ({ ok: true })));

vi.mock("@/runtime/trpc-client", () => ({
	getRuntimeTrpcClient: () => ({
		project: {
			commitSelectedFiles: { mutate: commitMutateMock },
			discardGitChanges: { mutate: discardGitChangesMutateMock },
			discardFile: { mutate: discardFileMutateMock },
		},
	}),
}));

vi.mock("@/components/app-toaster", () => ({
	showAppToast: vi.fn(),
}));

// ---------------------------------------------------------------------------
// Import the hook under test (after mocks are installed).
// ---------------------------------------------------------------------------

import { useCommitPanel } from "@/hooks/git/use-commit-panel";

// ---------------------------------------------------------------------------
// Test fixtures.
// ---------------------------------------------------------------------------

const mockFiles = [
	{ path: "src/foo.ts", status: "modified", additions: 5, deletions: 2, oldText: "", newText: "" },
	{ path: "src/bar.ts", status: "added", additions: 10, deletions: 0, oldText: "", newText: "" },
	{ path: "README.md", status: "modified", additions: 1, deletions: 1, oldText: "", newText: "" },
];

// ---------------------------------------------------------------------------
// Harness — captures the latest hook return value via an `onSnapshot` callback.
// ---------------------------------------------------------------------------

function HookHarness({
	taskId,
	projectId,
	baseRef,
	onSnapshot,
}: {
	taskId: string | null;
	projectId: string | null;
	baseRef: string | null;
	onSnapshot: (snapshot: UseCommitPanelResult) => void;
}): null {
	const result = useCommitPanel(taskId, projectId, baseRef);
	useEffect(() => {
		onSnapshot(result);
	});
	return null;
}

// ---------------------------------------------------------------------------
// Tests.
// ---------------------------------------------------------------------------

describe("useCommitPanel", () => {
	let container: HTMLDivElement;
	let root: Root;
	let latest: UseCommitPanelResult;
	let previousActEnvironment: boolean | undefined;

	beforeEach(() => {
		previousActEnvironment = (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean })
			.IS_REACT_ACT_ENVIRONMENT;
		(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

		container = document.createElement("div");
		document.body.appendChild(container);
		root = createRoot(container);

		commitMutateMock.mockClear();
		discardGitChangesMutateMock.mockClear();
		discardFileMutateMock.mockClear();

		// Default: return the three mock files.
		useRuntimeProjectChangesMock.mockReturnValue({
			changes: { files: mockFiles },
			isLoading: false,
		});

		// Default: on a named branch.
		useHomeGitSummaryValueMock.mockReturnValue({ currentBranch: "main" });
		useTaskProjectSnapshotValueMock.mockReturnValue(null);
	});

	afterEach(() => {
		act(() => {
			root.unmount();
		});
		container.remove();
		if (previousActEnvironment === undefined) {
			delete (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
		} else {
			(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
				previousActEnvironment;
		}
	});

	function render(props: { taskId?: string | null; projectId?: string | null; baseRef?: string | null } = {}): void {
		act(() => {
			root.render(
				createElement(HookHarness, {
					taskId: props.taskId ?? "task-1",
					projectId: props.projectId ?? "ws-1",
					baseRef: props.baseRef ?? "main",
					onSnapshot: (snapshot: UseCommitPanelResult) => {
						latest = snapshot;
					},
				}),
			);
		});
	}

	// -----------------------------------------------------------------------
	// 1. initializes all files as selected
	// -----------------------------------------------------------------------
	it("initializes all files as selected", () => {
		render();
		expect(latest.selectedPaths).toEqual(["src/foo.ts", "src/bar.ts", "README.md"]);
		expect(latest.isAllSelected).toBe(true);
		expect(latest.isIndeterminate).toBe(false);
	});

	// -----------------------------------------------------------------------
	// 2. toggleFile toggles individual file selection
	// -----------------------------------------------------------------------
	it("toggleFile toggles individual file selection", () => {
		render();
		expect(latest.selectedPaths).toContain("src/bar.ts");

		act(() => {
			latest.toggleFile("src/bar.ts");
		});

		expect(latest.selectedPaths).not.toContain("src/bar.ts");
		expect(latest.selectedPaths).toEqual(["src/foo.ts", "README.md"]);
	});

	// -----------------------------------------------------------------------
	// 3. toggleAll selects all when some unchecked
	// -----------------------------------------------------------------------
	it("toggleAll selects all when some unchecked", () => {
		render();

		// Uncheck one file first.
		act(() => {
			latest.toggleFile("src/foo.ts");
		});
		expect(latest.selectedPaths).not.toContain("src/foo.ts");
		expect(latest.isAllSelected).toBe(false);

		// Toggle all — should re-select everything.
		act(() => {
			latest.toggleAll();
		});
		expect(latest.selectedPaths).toEqual(["src/foo.ts", "src/bar.ts", "README.md"]);
		expect(latest.isAllSelected).toBe(true);
	});

	// -----------------------------------------------------------------------
	// 4. toggleAll deselects all when all checked
	// -----------------------------------------------------------------------
	it("toggleAll deselects all when all checked", () => {
		render();
		expect(latest.isAllSelected).toBe(true);

		act(() => {
			latest.toggleAll();
		});

		expect(latest.selectedPaths).toEqual([]);
		expect(latest.isAllSelected).toBe(false);
	});

	// -----------------------------------------------------------------------
	// 5. canCommit is false when no files selected
	// -----------------------------------------------------------------------
	it("canCommit is false when no files selected", () => {
		render();

		// Set a non-empty message so the only missing condition is file selection.
		act(() => {
			latest.setMessage("fix: something");
		});

		// Deselect all files.
		act(() => {
			latest.toggleAll();
		});
		expect(latest.selectedPaths).toEqual([]);
		expect(latest.canCommit).toBe(false);
	});

	// -----------------------------------------------------------------------
	// 6. canCommit is false when message is empty
	// -----------------------------------------------------------------------
	it("canCommit is false when message is empty", () => {
		render();
		// Files are selected, but message is "" by default.
		expect(latest.selectedPaths.length).toBeGreaterThan(0);
		expect(latest.message).toBe("");
		expect(latest.canCommit).toBe(false);
	});

	// -----------------------------------------------------------------------
	// 7. canCommit is true when files selected and message present
	// -----------------------------------------------------------------------
	it("canCommit is true when files selected and message present", () => {
		render();
		expect(latest.selectedPaths.length).toBeGreaterThan(0);

		act(() => {
			latest.setMessage("feat: add new feature");
		});

		expect(latest.canCommit).toBe(true);
	});

	// -----------------------------------------------------------------------
	// 8. syncs selection state when file list changes
	// -----------------------------------------------------------------------
	it("syncs selection state when file list changes", () => {
		render();
		expect(latest.selectedPaths).toEqual(["src/foo.ts", "src/bar.ts", "README.md"]);

		// Simulate file list changing: drop README.md, add src/new.ts.
		const updatedFiles = [
			{ path: "src/foo.ts", status: "modified", additions: 5, deletions: 2, oldText: "", newText: "" },
			{ path: "src/bar.ts", status: "added", additions: 10, deletions: 0, oldText: "", newText: "" },
			{ path: "src/new.ts", status: "added", additions: 3, deletions: 0, oldText: "", newText: "" },
		];
		useRuntimeProjectChangesMock.mockReturnValue({
			changes: { files: updatedFiles },
			isLoading: false,
		});

		// Re-render to pick up the new mock return value.
		act(() => {
			root.render(
				createElement(HookHarness, {
					taskId: "task-1",
					projectId: "ws-1",
					baseRef: "main",
					onSnapshot: (snapshot: UseCommitPanelResult) => {
						latest = snapshot;
					},
				}),
			);
		});

		// New file should be auto-selected; removed file should be gone.
		expect(latest.selectedPaths).toContain("src/new.ts");
		expect(latest.selectedPaths).not.toContain("README.md");
		// Original files that stayed should still be selected.
		expect(latest.selectedPaths).toContain("src/foo.ts");
		expect(latest.selectedPaths).toContain("src/bar.ts");
	});

	// -----------------------------------------------------------------------
	// 9. canPush is true on named branch with valid commit conditions
	// -----------------------------------------------------------------------
	it("canPush is true on named branch with valid commit conditions", () => {
		useTaskProjectSnapshotValueMock.mockReturnValue({ branch: "feat/my-branch", isDetached: false });
		render();

		act(() => {
			latest.setMessage("feat: push me");
		});

		expect(latest.canCommit).toBe(true);
		expect(latest.canPush).toBe(true);
	});

	// -----------------------------------------------------------------------
	// 10. canPush is false when on detached HEAD
	// -----------------------------------------------------------------------
	it("canPush is false when on detached HEAD", () => {
		useTaskProjectSnapshotValueMock.mockReturnValue({ branch: null, isDetached: true });
		render();

		act(() => {
			latest.setMessage("feat: detached");
		});

		expect(latest.canCommit).toBe(true);
		expect(latest.canPush).toBe(false);
	});

	// -----------------------------------------------------------------------
	// 11. commitAndPush sends pushAfterCommit: true in the mutation
	// -----------------------------------------------------------------------
	it("commitAndPush sends pushAfterCommit: true in the mutation", async () => {
		useTaskProjectSnapshotValueMock.mockReturnValue({ branch: "feat/my-branch", isDetached: false });
		commitMutateMock.mockResolvedValueOnce({ ok: true, pushOk: true, commitHash: "abc1234" });
		render();

		act(() => {
			latest.setMessage("feat: push it");
		});

		await act(async () => {
			await latest.commitAndPush();
		});

		expect(commitMutateMock).toHaveBeenCalledTimes(1);
		expect(commitMutateMock).toHaveBeenCalledWith(expect.objectContaining({ pushAfterCommit: true }));
	});
});
