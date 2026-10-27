import { act, type ComponentProps, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CompareBar } from "@/components/git/git-view-compare-bar";
import type { DiffViewerPanel } from "@/components/git/panels/diff-viewer-panel";
import { diffCodeNavigationUnavailableReason } from "@/hooks/git/diff-code-navigation";
import { createReviewDocument } from "@/hooks/git/review-document";
import type { UseGitDiffDataOptions } from "@/hooks/git/use-git-diff-data";
import type { UseRuntimeStateStreamResult } from "@/runtime/use-runtime-state-stream";
import { getProjectMetadataProjectId, getProjectPath, getTaskWorktreeInfo } from "@/stores/project-metadata-store";
import { createTestProjectStateResponse } from "@/test-utils/task-session-factory";
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
		return (
			<button
				type="button"
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
	beforeEach(() => {
		vi.clearAllMocks();
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
		});
		container = document.createElement("div");
		document.body.append(container);
		root = createRoot(container);
	});
	afterEach(async () => {
		await act(async () => root.unmount());
		container.remove();
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
		expect(lastViewer().reviewScope.repository).toMatchObject({
			projectId: "p1",
			taskId: "task-1",
			taskCreatedAt: 10,
			rootPath: "/repo/worktree",
		});
		expect(lastViewer().selectedPath).toBe("src/pinned.ts");
		expect(lastViewer().onAddToTerminal).toBeUndefined();
		expect(lastViewer().onSendToTerminal).toBeUndefined();
		expect(lastViewer().onRollbackFile).toBeUndefined();
		expect(mocks.editor).not.toHaveBeenCalled();
	});

	it("retains captured identity and local choices across prop navigation and authoritative refresh", async () => {
		await render();
		await act(async () => {
			(container.querySelector("button") as HTMLButtonElement).click();
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

	it("opens an exact-range read-only live preview, never a Files editor workspace", async () => {
		await render();
		const button = Array.from(container.querySelectorAll("button")).find(
			(element) => element.textContent === "Open definition",
		);
		await act(async () => button?.click());
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
		expect(container.textContent).toContain("Live file · Read-only");
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
		},
	);
});
