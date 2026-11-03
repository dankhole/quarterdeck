import { act, type ComponentProps, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CompareBar } from "@/components/git/git-view-compare-bar";
import { DiffCodeNavigationMenu } from "@/components/git/panels/diff-code-navigation-menu";
import type { DiffViewerPanel } from "@/components/git/panels/diff-viewer-panel";
import { diffCodeNavigationUnavailableReason } from "@/hooks/git/diff-code-navigation";
import { createReviewDocument } from "@/hooks/git/review-document";
import type { UseGitDiffDataOptions } from "@/hooks/git/use-git-diff-data";
import type { UseRuntimeStateStreamResult } from "@/runtime/use-runtime-state-stream";
import { getProjectMetadataProjectId, getProjectPath, getTaskWorktreeInfo } from "@/stores/project-metadata-store";
import { createTestProjectStateResponse } from "@/test-utils/task-session-factory";
import { isMacPlatform } from "@/utils/platform";
import type { CompareWindowTarget } from "../../../../src/shared/compare-window-contract";
import { CompareWindowRoot } from "./compare-window-root";

const mocks = vi.hoisted(() => ({
	stream: vi.fn(),
	diff: vi.fn(),
	refs: vi.fn(),
	file: vi.fn(),
	editor: vi.fn(),
	compare: vi.fn(),
	viewer: vi.fn(),
	preferences: vi.fn(),
	refresh: vi.fn(),
	navigationRegion: false,
	selectNavigation: vi.fn(),
}));
vi.mock("@/providers/ui-preferences-boundary", () => ({
	UiPreferencesBoundary: ({ children, readOnly }: { children: ReactNode; readOnly?: boolean }) => {
		mocks.preferences(readOnly);
		return <>{children}</>;
	},
}));
vi.mock("@/runtime/use-runtime-state-stream", () => ({ useRuntimeStateStream: mocks.stream }));
vi.mock("@/runtime/trpc-client", () => ({
	getRuntimeTrpcClient: () => ({
		project: { getGitRefs: { query: mocks.refs }, getFileContent: { query: mocks.file } },
	}),
}));
vi.mock("@/runtime/use-runtime-project-config", () => ({
	useRuntimeProjectConfig: () => ({ config: { codeNavigationEnabled: true, lspServers: [] } }),
}));
vi.mock("@/hooks/git/use-git-diff-data", () => ({ useGitDiffData: mocks.diff }));
vi.mock("@/hooks/git/use-diff-code-navigation", () => ({
	useDiffCodeNavigation: () => ({
		actions: [
			{ id: "code-navigation-references", label: "Find Usages" },
			{ id: "code-navigation-definition", label: "Go to Definition" },
		],
		result: null,
		documentVersion: 1,
		dismiss: vi.fn(),
		select: mocks.selectNavigation,
	}),
}));
vi.mock("@/components/editor/source-editor", () => ({
	SourceEditor: (props: object) => {
		mocks.editor(props);
		return <div data-preview-editor />;
	},
}));
vi.mock("@/components/git/git-view-compare-bar", () => ({
	CompareBar: (props: ComponentProps<typeof CompareBar>) => {
		mocks.compare(props);
		return (
			<button
				type="button"
				onClick={() => {
					props.onSourceRefChange("local-topic");
					props.onIncludeUncommittedChange(false);
					props.onThreeDotDiffChange(true);
				}}
			>
				Change comparison
			</button>
		);
	},
}));
vi.mock("@/components/git/panels/file-tree-panel", () => ({ FileTreePanel: () => <div data-file-tree /> }));
vi.mock("@/components/git/panels/diff-viewer-panel", () => ({
	DiffViewerPanel: (props: ComponentProps<typeof DiffViewerPanel>) => {
		mocks.viewer(props);
		const content = (
			<button
				type="button"
				data-diff-scroll-container
				onClick={() =>
					props.navigateToFile?.({
						targetView: "files",
						filePath: "src/result.ts",
						codeTaskId: "task-1",
						codeLocation: {
							path: "src/result.ts",
							range: { start: { line: 8, character: 3 }, end: { line: 8, character: 9 } },
						},
					})
				}
			>
				Open definition
			</button>
		);
		if (!mocks.navigationRegion) return content;
		return (
			<DiffCodeNavigationMenu
				document={createReviewDocument(
					props.reviewScope,
					{ path: "src/pinned.ts" },
					{ kind: "text", oldText: "old()", newText: "new()" },
				)}
				options={{
					projectId: props.reviewScope.repository.projectId,
					scope: { taskId: props.reviewScope.repository.taskId },
					config: null,
				}}
				onNavigate={() => {}}
			>
				{content}
			</DiffCodeNavigationMenu>
		);
	},
}));

const target: CompareWindowTarget = {
	projectId: "p1",
	taskId: "task-1",
	taskCreatedAt: 10,
	sourceRef: "topic",
	targetRef: "main",
	includeUncommitted: true,
	threeDotDiff: false,
	selectedPath: "src/pinned.ts",
};

function fixture(): UseRuntimeStateStreamResult {
	return {
		currentProjectId: "p1",
		projects: [
			{
				id: "p1",
				name: "Pinned project",
				path: "/repo/p1",
				boardRevision: 1,
				taskCounts: { in_progress: 0, review: 1, trash: 0 },
			},
		],
		organization: null,
		applyOrganization: vi.fn(),
		applyProjectManagementResult: vi.fn(),
		projectState: createTestProjectStateResponse({
			repoPath: "/repo/p1",
			revision: 1,
			board: {
				columns: [
					{
						id: "review",
						title: "Review",
						cards: [
							{
								id: "task-1",
								title: "Pinned task",
								prompt: "work",
								baseRef: "main",
								createdAt: 10,
								updatedAt: 10,
							},
						],
					},
				],
			},
		}),
		projectMetadata: {
			homeGitSummary: null,
			homeGitStateVersion: 0,
			homeStashCount: 0,
			taskWorktrees: [
				{
					taskId: "task-1",
					path: "/repo/worktree",
					exists: true,
					baseRef: "main",
					branch: "topic",
					isDetached: false,
					headCommit: "abc",
					changedFiles: 1,
					additions: 1,
					deletions: 0,
					hasUnmergedChanges: false,
					behindBaseCount: 0,
					behindRemoteBaseCount: 0,
					stateVersion: 1,
				},
			],
		},
		notificationProjects: {},
		latestTaskReadyForReview: null,
		latestTaskTitleUpdate: null,
		latestTaskBaseRefUpdate: null,
		streamError: null,
		isRuntimeDisconnected: false,
		hasReceivedSnapshot: true,
	};
}

describe("standalone Compare root", () => {
	let root: Root;
	let container: HTMLDivElement;
	let stream: UseRuntimeStateStreamResult;
	let priorActEnvironment: boolean | undefined;
	beforeEach(() => {
		priorActEnvironment = (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
		(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
		vi.clearAllMocks();
		mocks.navigationRegion = false;
		stream = fixture();
		mocks.stream.mockImplementation(() => stream);
		mocks.refs.mockResolvedValue({ ok: true, refs: [] });
		mocks.file.mockResolvedValue({
			content: "live text",
			language: "typescript",
			binary: false,
			truncated: false,
			size: 9,
		});
		mocks.diff.mockReturnValue({
			activeFiles: [],
			enrichedFiles: [],
			isRuntimeAvailable: true,
			isChangesPending: false,
			hasNoChanges: false,
			fileLoadingState: {},
			refresh: mocks.refresh,
			isRefreshing: false,
			changesError: null,
		});
		container = document.createElement("div");
		document.body.append(container);
		root = createRoot(container);
	});
	afterEach(async () => {
		await act(async () => root.unmount());
		container.remove();
		(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = priorActEnvironment;
	});
	async function render(nextTarget = target): Promise<void> {
		await act(async () => root.render(<CompareWindowRoot target={nextTarget} />));
	}
	function lastCompare(): ComponentProps<typeof CompareBar> {
		return mocks.compare.mock.calls.at(-1)?.[0] as ComponentProps<typeof CompareBar>;
	}
	function lastViewer(): ComponentProps<typeof DiffViewerPanel> {
		return mocks.viewer.mock.calls.at(-1)?.[0] as ComponentProps<typeof DiffViewerPanel>;
	}

	it("bootstraps only captured project metadata and read-only review without PTY or recovery APIs", async () => {
		await render();
		expect(container.textContent).toContain("Pinned project · Pinned task");
		expect(mocks.preferences).toHaveBeenCalledWith(true);
		expect(mocks.stream).toHaveBeenCalledWith("p1");
		expect(getProjectMetadataProjectId()).toBe("p1");
		expect(getProjectPath()).toBe("/repo/p1");
		expect(getTaskWorktreeInfo("task-1")?.path).toBe("/repo/worktree");
		expect(lastViewer().readOnlyReview).toBe(true);
		expect(lastViewer().presentation).toBe("focused");
		expect(lastViewer().comments.size).toBe(0);
		expect(lastViewer().reviewScope.repository).toMatchObject({
			projectId: "p1",
			taskId: "task-1",
			taskCreatedAt: 10,
			rootPath: "/repo/worktree",
		});
		expect(lastViewer().selectedPath).toBe("src/pinned.ts");
		expect(lastViewer()).not.toHaveProperty("onAddToTerminal");
		expect(lastViewer().onSendToTerminal).toBeUndefined();
		expect(lastViewer().onRollbackFile).toBeUndefined();
		expect(mocks.editor).not.toHaveBeenCalled();
	});

	it("retains captured identity and local choices across prop navigation and authoritative refresh", async () => {
		await render();
		await act(async () => {
			Array.from(container.querySelectorAll("button"))
				.find((button) => button.textContent === "Change comparison")
				?.click();
		});
		stream = { ...stream, projectMetadata: { ...stream.projectMetadata!, homeGitStateVersion: 2 } };
		await render({ ...target, projectId: "other", taskId: null, taskCreatedAt: undefined, sourceRef: "different" });
		expect(mocks.stream).toHaveBeenLastCalledWith("p1");
		expect(lastCompare()).toMatchObject({
			sourceRef: "local-topic",
			targetRef: "main",
			includeUncommitted: false,
			threeDotDiff: true,
		});
		const diffOptions = mocks.diff.mock.calls.at(-1)?.[0] as UseGitDiffDataOptions;
		expect(diffOptions).toMatchObject({ currentProjectId: "p1", taskId: "task-1", selectedPath: "src/pinned.ts" });
	});

	it("distinguishes a captured committed WORKTREE branch from live content with identical labels", async () => {
		await render({ ...target, sourceRef: "WORKTREE", includeUncommitted: false });
		const currentDocument = () =>
			createReviewDocument(
				lastViewer().reviewScope,
				{ path: "src/app.ts" },
				{ kind: "text", oldText: "old()", newText: "identical()" },
			);
		const historical = currentDocument();
		expect(historical.revisions).toMatchObject({ kind: "compare", head: "WORKTREE", headSource: "revision" });
		expect(diffCodeNavigationUnavailableReason(historical)).toContain("historical");
		await act(async () => lastCompare().onIncludeUncommittedChange(true));
		const live = currentDocument();
		expect(live.revisions).toMatchObject({ kind: "compare", head: "WORKTREE", headSource: "live-worktree" });
		expect(diffCodeNavigationUnavailableReason(live)).toBeNull();
		expect(live.key).not.toBe(historical.key);
	});

	it.each([null, "task-1"])(
		"uses the working-copy query and HEAD semantics for Uncommitted in scope %s",
		async (taskId) => {
			await render({
				...target,
				taskId,
				taskCreatedAt: taskId ? 10 : undefined,
				reviewMode: "uncommitted",
				sourceRef: "HEAD",
				targetRef: "HEAD",
				includeUncommitted: true,
				threeDotDiff: false,
			});
			expect(mocks.diff.mock.calls.at(-1)?.[0]).toMatchObject({
				activeTab: "uncommitted",
				currentProjectId: "p1",
				taskId,
			});
			expect(lastViewer().reviewScope.revisions).toEqual({
				kind: "working-copy",
				base: "HEAD",
				head: "WORKTREE",
				headSource: "live-worktree",
				mode: "two_dot",
			});
			expect(mocks.refs).not.toHaveBeenCalled();
			expect(mocks.compare).not.toHaveBeenCalled();
			expect(container.textContent).toContain("including untracked files");
		},
	);

	it("refreshes through the scoped data owner and keeps the review mounted across loading and errors", async () => {
		await render();
		const diff = container.querySelector("[data-diff-scroll-container]");
		await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="Refresh review"]')?.click());
		expect(mocks.refresh).toHaveBeenCalledOnce();
		mocks.diff.mockReturnValue({
			activeFiles: [],
			enrichedFiles: [],
			isRuntimeAvailable: true,
			isChangesPending: false,
			hasNoChanges: false,
			fileLoadingState: {},
			refresh: mocks.refresh,
			isRefreshing: true,
			changesError: null,
		});
		await render();
		// Background polling must not insert a banner and move the review viewport.
		expect(container.textContent).not.toContain("Refreshing review…");
		expect(container.querySelector('[aria-label="Refresh review"]')?.getAttribute("aria-busy")).toBe("true");
		expect(container.querySelector<HTMLButtonElement>('[aria-label="Refresh review"]')?.disabled).toBe(true);
		expect(container.querySelector("[data-diff-scroll-container]")).toBe(diff);
		mocks.diff.mockReturnValue({
			activeFiles: [],
			enrichedFiles: [],
			isRuntimeAvailable: false,
			isChangesPending: false,
			hasNoChanges: false,
			fileLoadingState: {},
			refresh: mocks.refresh,
			isRefreshing: false,
			changesError: "Unknown revision topic",
		});
		await render();
		expect(container.querySelector('[role="alert"]')?.textContent).toContain("Unknown revision topic");
		expect(container.textContent).not.toContain("No changes in this comparison");
		expect(container.querySelector<HTMLButtonElement>('[aria-label="Refresh review"]')?.disabled).toBe(false);
		expect(container.querySelector("[data-diff-scroll-container]")).toBe(diff);
		expect(lastViewer().selectedPath).toBe("src/pinned.ts");
	});

	it("shows an initial metadata error without a false empty or loading diff", async () => {
		mocks.diff.mockReturnValue({
			activeFiles: null,
			enrichedFiles: null,
			isRuntimeAvailable: false,
			isChangesPending: false,
			hasNoChanges: false,
			fileLoadingState: {},
			refresh: mocks.refresh,
			isRefreshing: false,
			changesError: "Git unavailable",
		});
		await render();
		expect(container.querySelector('[role="alert"]')?.textContent).toContain("Git unavailable");
		expect(container.textContent).not.toContain("No changes in this comparison");
		expect(container.querySelector("[data-diff-scroll-container]")?.parentElement?.className).toBe("hidden");
		expect(container.querySelector<HTMLButtonElement>('[aria-label="Refresh review"]')?.disabled).toBe(false);
	});

	it("collapses the file tree without unmounting the focused review", async () => {
		await render();
		const diff = Array.from(container.querySelectorAll("button")).find(
			(button) => button.textContent === "Open definition",
		);
		await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="Hide file tree"]')?.click());
		expect(container.querySelector("aside")?.hidden).toBe(true);
		expect(container.querySelector('[aria-label="Show file tree"]')?.getAttribute("aria-expanded")).toBe("false");
		expect(
			Array.from(container.querySelectorAll("button")).find((button) => button.textContent === "Open definition"),
		).toBe(diff);
		expect(lastViewer().selectedPath).toBe("src/pinned.ts");
	});

	it("retains the mounted viewer and scoped files across query failure, loading and reconnect", async () => {
		const files = [{ path: "src/pinned.ts", status: "modified", oldContent: "a", newContent: "b" }];
		mocks.diff.mockReturnValue({
			activeFiles: files,
			enrichedFiles: files,
			isRuntimeAvailable: true,
			isChangesPending: false,
			hasNoChanges: false,
			fileLoadingState: {},
		});
		await render();
		const diff = Array.from(container.querySelectorAll("button")).find(
			(button) => button.textContent === "Open definition",
		);
		for (const failure of ["query", "loading", "reconnect"]) {
			mocks.diff.mockReturnValue({
				activeFiles: null,
				enrichedFiles: null,
				isRuntimeAvailable: failure !== "query",
				isChangesPending: failure !== "query",
				hasNoChanges: false,
				fileLoadingState: {},
			});
			stream = { ...stream, isRuntimeDisconnected: failure === "reconnect" };
			await render();
			expect(
				Array.from(container.querySelectorAll("button")).find((button) => button.textContent === "Open definition"),
			).toBe(diff);
			expect(lastViewer().projectFiles).toBe(files);
			expect(lastViewer().selectedPath).toBe("src/pinned.ts");
		}
		stream = { ...stream, isRuntimeDisconnected: false };
		await render();
		expect(
			Array.from(container.querySelectorAll("button")).find((button) => button.textContent === "Open definition"),
		).toBe(diff);
	});

	it("never reuses retained files after a ref/head-source context change", async () => {
		const files = [{ path: "old.ts" }];
		mocks.diff.mockReturnValue({
			activeFiles: files,
			enrichedFiles: files,
			isRuntimeAvailable: true,
			isChangesPending: false,
			hasNoChanges: false,
			fileLoadingState: {},
		});
		await render({ ...target, sourceRef: "WORKTREE", includeUncommitted: false });
		mocks.diff.mockReturnValue({
			activeFiles: null,
			enrichedFiles: null,
			isRuntimeAvailable: true,
			isChangesPending: true,
			hasNoChanges: false,
			fileLoadingState: {},
		});
		await act(async () => lastCompare().onIncludeUncommittedChange(true));
		expect(lastViewer().projectFiles).toBeNull();
	});

	it("opens an exact-range read-only live preview, never a Files editor workspace", async () => {
		await render();
		const button = Array.from(container.querySelectorAll("button")).find(
			(element) => element.textContent === "Open definition",
		);
		button?.focus();
		await act(async () => button?.click());
		expect(document.querySelector('[role="dialog"]')).not.toBeNull();
		expect(
			Array.from(container.querySelectorAll("button")).find((element) => element.textContent === "Open definition"),
		).toBe(button);
		expect(mocks.file).toHaveBeenCalledWith({ taskId: "task-1", baseRef: "main", path: "src/result.ts" });
		const editor = mocks.editor.mock.calls.at(-1)?.[0];
		expect(editor).toMatchObject({
			path: "src/result.ts",
			value: "live text",
			readOnly: true,
			scrollToRange: { start: { line: 8, character: 3 }, end: { line: 8, character: 9 } },
		});
		expect(editor.onSave).toBeUndefined();
		expect(editor.actions).toBeUndefined();
		expect(document.body.textContent).toContain("Live file · Read-only snapshot");
		await act(async () => document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
		expect(document.querySelector('[role="dialog"]')).toBeNull();
		expect(
			Array.from(container.querySelectorAll("button")).find((element) => element.textContent === "Open definition"),
		).toBe(button);
		expect(lastViewer().selectedPath).toBe("src/pinned.ts");
		await act(async () => {
			await new Promise((resolve) => window.setTimeout(resolve, 0));
		});
		expect(document.activeElement).toBe(button);
	});

	it("restores symbol navigation shortcuts after the invoking results overlay has gone away", async () => {
		mocks.navigationRegion = true;
		await render();
		const result = document.createElement("button");
		document.body.append(result);
		result.focus();
		await act(async () =>
			lastViewer().navigateToFile?.({ targetView: "files", filePath: "src/result.ts", codeTaskId: "task-1" }),
		);
		result.remove();
		await act(async () => document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
		await act(async () => {
			await new Promise((resolve) => window.setTimeout(resolve, 0));
		});
		const navigationSurface = container.querySelector<HTMLElement>('[aria-label="Diff code navigation"]');
		expect(document.activeElement).toBe(navigationSurface);
		await act(async () => {
			document.activeElement?.dispatchEvent(
				new KeyboardEvent("keydown", { key: "F7", altKey: true, bubbles: true }),
			);
			document.activeElement?.dispatchEvent(
				new KeyboardEvent("keydown", { key: "b", metaKey: isMacPlatform, ctrlKey: !isMacPlatform, bubbles: true }),
			);
		});
		expect(mocks.selectNavigation.mock.calls.map(([action]) => action.id)).toEqual([
			"code-navigation-references",
			"code-navigation-definition",
		]);
	});

	it("rejects navigation into a different task rather than retargeting its source reader", async () => {
		await render();
		await act(async () =>
			lastViewer().navigateToFile?.({ targetView: "files", filePath: "src/result.ts", codeTaskId: "other-task" }),
		);
		expect(mocks.file).not.toHaveBeenCalled();
		expect(document.querySelector('[role="dialog"]')).toBeNull();
	});

	it("reseeds invalidated retained context only after a newly validated ready snapshot", async () => {
		await render();
		const removed = structuredClone(stream.projectState!);
		removed.revision = 2;
		removed.board.columns[0]!.cards = [];
		stream = { ...stream, projectState: removed };
		await render();
		expect(container.querySelector('[aria-label="Standalone Compare"]')).toBeNull();
		const restored = fixture().projectState!;
		restored.revision = 3;
		stream = { ...stream, projectState: restored, isRuntimeDisconnected: true };
		mocks.diff.mockClear();
		await render();
		expect(mocks.diff).not.toHaveBeenCalled();
		expect(container.querySelector('[aria-label="Standalone Compare"]')).toBeNull();
		stream = { ...stream, isRuntimeDisconnected: false };
		await render();
		expect(mocks.diff).toHaveBeenCalled();
		expect(lastViewer().reviewScope.repository.taskCreatedAt).toBe(10);
	});

	it.each(["removed", "replaced", "trash", "missing-worktree", "project-unavailable", "wrong-project"])(
		"fails explicitly for %s without falling back home",
		async (reason) => {
			await render();
			const projectState = structuredClone(stream.projectState!);
			projectState.revision = 2;
			if (reason === "removed") projectState.board.columns[0]!.cards = [];
			if (reason === "replaced") projectState.board.columns[0]!.cards[0]!.createdAt = 11;
			if (reason === "trash") projectState.board.columns[0]!.id = "trash";
			stream = { ...stream, projectState };
			if (reason === "missing-worktree")
				stream = { ...stream, projectMetadata: { ...stream.projectMetadata!, taskWorktrees: [] } };
			if (reason === "project-unavailable")
				stream = {
					...stream,
					projects: [{ ...stream.projects[0]!, availability: { status: "unavailable", reason: "missing" } }],
				};
			if (reason === "wrong-project") stream = { ...stream, currentProjectId: "p2" };
			mocks.diff.mockClear();
			await render();
			expect(container.querySelector('[role="alert"]')?.textContent).toContain("Compare unavailable");
			expect(container.querySelector('[aria-label="Standalone Compare"]')).toBeNull();
			expect(
				mocks.diff.mock.calls.every(
					([options]) => options.taskId === "task-1" && options.currentProjectId === "p1",
				),
			).toBe(true);
			// A later recoverable stream failure must not revive the invalidated repository.
			mocks.diff.mockClear();
			mocks.viewer.mockClear();
			mocks.refs.mockClear();
			mocks.file.mockClear();
			stream = { ...stream, isRuntimeDisconnected: true };
			await render();
			expect(container.querySelector('[aria-label="Standalone Compare"]')).toBeNull();
			expect(mocks.diff).not.toHaveBeenCalled();
			expect(mocks.refs).not.toHaveBeenCalled();
			expect(mocks.file).not.toHaveBeenCalled();
			expect(mocks.viewer).not.toHaveBeenCalled();
		},
	);
});
