import type { RuntimeGitViewPreference } from "@runtime-contract";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DiffLineComment } from "@/components/git/panels/diff-viewer-utils";
import { sharedUiPreferences } from "@/storage/shared-ui-preferences";
import type { CardSelection } from "@/types";
import { type UseGitViewOptions, type UseGitViewResult, useGitView } from "./use-git-view";

const mocks = vi.hoisted(() => ({
	rootPath: undefined as string | undefined,
	sourceRef: "feature",
}));
vi.mock("@/stores/project-metadata-store", () => ({
	useTaskRepositoryInfoValue: () => (mocks.rootPath ? { path: mocks.rootPath } : null),
}));
vi.mock("@/hooks/git/use-conflict-resolution", () => ({ useConflictResolution: () => ({ isActive: false }) }));
vi.mock("@/hooks/git/use-git-view-compare", () => ({
	useGitViewCompare: () => ({
		sourceRef: mocks.sourceRef,
		targetRef: "main",
		includeUncommitted: true,
		threeDotDiff: true,
	}),
}));
vi.mock("@/hooks/git/use-git-diff-data", () => ({
	useGitDiffData: () => ({ activeFiles: [], enrichedFiles: [], hasNoChanges: true }),
}));
vi.mock("@/hooks/settings/use-preference-storage-effect", () => ({ usePreferenceStorageEffect: () => {} }));
vi.mock("@/resize/use-resize-drag", () => ({ useResizeDrag: () => ({ startDrag: vi.fn() }) }));
vi.mock("@/resize/resize-preferences", () => ({
	loadResizePreference: () => 0.22,
	persistResizePreference: (_key: unknown, value: number) => value,
}));
vi.mock("@/hooks/git/git-view", () => ({
	getLastSelectedPath: () => null,
	setLastSelectedPath: () => {},
	isTaskBaseRefResolved: () => true,
	gitViewPreferenceScopeKey: (projectId: string, taskId: string | null, createdAt?: number) =>
		JSON.stringify([projectId, taskId, taskId ? (createdAt ?? null) : null]),
}));

const comment: DiffLineComment = {
	filePath: "a.ts",
	lineNumber: 1,
	lineText: "code",
	variant: "added",
	comment: "Draft",
};
let root: Root;
let container: HTMLDivElement;
let latest: UseGitViewResult;
let project: string;
let sequence = 0;
const preferences = new Map<string, RuntimeGitViewPreference>();
let navigation: Partial<UseGitViewOptions> = {};
function selection(id: string, createdAt = 1): CardSelection {
	const card = { id, createdAt, updatedAt: createdAt, title: null, prompt: "Task", baseRef: "main" };
	const column = { id: "review" as const, title: "Review", cards: [card] };
	return { card, column, allColumns: [column] };
}
function Harness({ task }: { task: CardSelection | null }) {
	latest = useGitView({ currentProjectId: project, selectedCard: task, projectPath: "/project", ...navigation });
	return null;
}
function render(task: CardSelection | null = selection("task")) {
	act(() => root.render(<Harness task={task} />));
}
beforeEach(() => {
	project = `review-git-view-${++sequence}`;
	mocks.rootPath = undefined;
	mocks.sourceRef = "feature";
	preferences.clear();
	navigation = {};
	vi.spyOn(sharedUiPreferences, "readGitView").mockImplementation((scope) => preferences.get(scope) ?? {});
	vi.spyOn(sharedUiPreferences, "writeGitView").mockImplementation((scope, patch) => {
		preferences.set(scope, { ...preferences.get(scope), ...patch });
	});
	container = document.createElement("div");
	document.body.append(container);
	root = createRoot(container);
	render();
});
afterEach(() => {
	act(() => root.unmount());
	container.remove();
	vi.restoreAllMocks();
});

describe("useGitView review owner", () => {
	it("restores each task tab and folders across switches and remounts", () => {
		act(() => latest.setActiveTab("compare"));
		act(() => latest.setCollapsedDirectories(new Set(["src", "src/nested"])));
		render(selection("other"));
		expect(latest.activeTab).toBe("uncommitted");
		expect([...latest.collapsedDirectories]).toEqual([]);
		act(() => latest.setCollapsedDirectories(new Set(["docs"])));
		render();
		expect(latest.activeTab).toBe("compare");
		expect([...latest.collapsedDirectories]).toEqual(["src", "src/nested"]);
		act(() => root.render(null));
		render();
		expect(latest.activeTab).toBe("compare");
		expect([...latest.collapsedDirectories]).toEqual(["src", "src/nested"]);
		act(() => latest.setCollapsedDirectories(new Set(["src/nested"])));
		act(() => root.render(null));
		render();
		expect([...latest.collapsedDirectories]).toEqual(["src/nested"]);
		render(selection("other"));
		expect(latest.activeTab).toBe("uncommitted");
		expect([...latest.collapsedDirectories]).toEqual(["docs"]);
	});

	it("isolates projects, home and recreated tasks", () => {
		act(() => latest.setActiveTab("compare"));
		act(() => latest.setCollapsedDirectories(new Set(["src"])));
		render(selection("task", 2));
		expect(latest.activeTab).toBe("uncommitted");
		expect(latest.collapsedDirectories.size).toBe(0);
		render(null);
		expect(latest.activeTab).toBe("uncommitted");
		const originalProject = project;
		project = "other-project";
		render();
		expect(latest.activeTab).toBe("uncommitted");
		project = originalProject;
		render();
		expect(latest.activeTab).toBe("compare");
		expect([...latest.collapsedDirectories]).toEqual(["src"]);
	});

	it("lets explicit file navigation override and remember the restored tab", () => {
		act(() => latest.setActiveTab("compare"));
		act(() => root.render(null));
		navigation = {
			pendingFileNavigation: { targetView: "git", filePath: "a.ts" },
			onFileNavigationConsumed: vi.fn(),
		};
		render();
		expect(latest.activeTab).toBe("uncommitted");
		expect(navigation.onFileNavigationConsumed).toHaveBeenCalled();
		navigation = {};
		act(() => root.render(null));
		render();
		expect(latest.activeTab).toBe("uncommitted");
	});

	it("retains drafts across root metadata hydration, comparison switches and unmount", () => {
		const uncommittedKey = latest.reviewDraftKey;
		act(() => latest.setDiffComments(new Map([["draft", comment]])));
		mocks.rootPath = "/project/worktrees/task";
		render();
		expect(latest.reviewDraftKey).toBe(uncommittedKey);
		expect(latest.diffComments.get("draft")).toBe(comment);
		act(() => latest.setActiveTab("compare"));
		expect(latest.diffComments.size).toBe(0);
		act(() => latest.setDiffComments(new Map([["compare", comment]])));
		const compareKey = latest.reviewDraftKey;
		mocks.sourceRef = "other";
		render();
		expect(latest.diffComments.size).toBe(0);
		mocks.sourceRef = "feature";
		render();
		expect(latest.reviewDraftKey).toBe(compareKey);
		expect(latest.diffComments.has("compare")).toBe(true);
		act(() => latest.setActiveTab("uncommitted"));
		act(() => root.render(null));
		render();
		expect(latest.diffComments.has("draft")).toBe(true);
	});

	it("old setter remains bound to origin after navigation and task recreation is isolated", () => {
		act(() => latest.setDiffComments(new Map([["original", comment]])));
		const originalSetter = latest.setDiffComments;
		render(selection("other"));
		act(() => latest.setDiffComments(new Map([["other", comment]])));
		const otherComments = latest.diffComments;
		act(() => originalSetter(new Map()));
		expect(latest.diffComments).toBe(otherComments);
		render();
		expect(latest.diffComments.size).toBe(0);
		act(() => latest.setDiffComments(new Map([["original", comment]])));
		render(selection("task", 2));
		expect(latest.diffComments.size).toBe(0);
		render();
		expect(latest.diffComments.has("original")).toBe(true);
	});
});
