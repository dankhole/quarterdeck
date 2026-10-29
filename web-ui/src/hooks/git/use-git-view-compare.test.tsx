import { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LocalStorageKey } from "@/storage/local-storage-store";
import type { CardSelection } from "@/types";
import { type UseGitViewCompareOptions, type UseGitViewCompareResult, useGitViewCompare } from "./use-git-view-compare";

const mocks = vi.hoisted(() => ({ defaultSource: "feature/default", preferences: new Map<string, boolean>() }));
vi.mock("@/hooks/git/git-view-compare", () => ({ resolveDefaultCompareSourceRef: () => mocks.defaultSource }));
vi.mock("@/stores/project-metadata-store", () => ({
	useTaskRepositoryInfoValue: () => null,
	useTaskWorktreeSnapshotValue: () => null,
}));
vi.mock("@/runtime/use-trpc-query", () => ({ useTrpcQuery: () => ({ data: null }) }));
vi.mock("@/runtime/trpc-client", () => ({ getRuntimeTrpcClient: vi.fn() }));
vi.mock("@/hooks/git/use-worktree-branches", () => ({ useWorktreeBranches: () => new Map() }));
vi.mock("@/utils/react-use", () => ({
	useBooleanLocalStorageValue: (key: string, initialValue: boolean) => {
		const [value, setValue] = useState(() => mocks.preferences.get(key) ?? initialValue);
		return [
			value,
			(next: boolean) => {
				mocks.preferences.set(key, next);
				setValue(next);
			},
		];
	},
}));

let root: Root;
let container: HTMLDivElement;
let latest: UseGitViewCompareResult;
let options: UseGitViewCompareOptions;
let sequence = 0;
let previousActEnvironment: boolean | undefined;
function selection(id = "task", createdAt = 1, baseRef = "main"): CardSelection {
	const card = { id, createdAt, updatedAt: createdAt, title: null, prompt: "Task", baseRef };
	const column = { id: "review" as const, title: "Review", cards: [card] };
	return { card, column, allColumns: [column] };
}
function Harness({ value }: { value: UseGitViewCompareOptions }) {
	latest = useGitViewCompare(value);
	return null;
}
function render(changes: Partial<UseGitViewCompareOptions> = {}) {
	options = { ...options, ...changes };
	act(() => root.render(<Harness value={options} />));
}
beforeEach(() => {
	previousActEnvironment = (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
	(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
	mocks.defaultSource = "feature/default";
	mocks.preferences.clear();
	options = {
		currentProjectId: `compare-retention-${++sequence}`,
		selectedCard: selection(),
		projectPath: "/repo",
		homeGitSummary: null,
		board: { columns: [] },
		isActive: true,
	};
	container = document.createElement("div");
	document.body.append(container);
	root = createRoot(container);
	render();
});
afterEach(() => {
	act(() => root.unmount());
	container.remove();
	(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = previousActEnvironment;
});

describe("useGitViewCompare window selections", () => {
	it("restores custom refs and options after Git unmounts for Terminal navigation", () => {
		act(() => {
			latest.setSourceRef("feature/review");
			latest.setTargetRef("release");
			latest.setIncludeUncommitted(false);
			latest.setThreeDotDiff(false);
		});
		act(() => root.render(null));
		render();
		expect(latest.sourceRef).toBe("feature/review");
		expect(latest.targetRef).toBe("release");
		expect(latest.includeUncommitted).toBe(false);
		expect(latest.threeDotDiff).toBe(false);
	});

	it("isolates project, task and recreated-task selections including option choices", () => {
		const originalProject = options.currentProjectId;
		act(() => latest.setSourceRef("task-a-review"));
		render({ selectedCard: selection("other") });
		expect(latest.sourceRef).toBe("feature/default");
		act(() => {
			latest.setSourceRef("task-b-review");
			latest.setIncludeUncommitted(false);
		});
		render({ selectedCard: selection() });
		expect(latest.sourceRef).toBe("task-a-review");
		expect(latest.includeUncommitted).toBe(true);
		render({ selectedCard: selection("task", 2) });
		expect(latest.sourceRef).toBe("feature/default");
		render({ currentProjectId: `${originalProject}-other`, selectedCard: selection() });
		expect(latest.sourceRef).toBe("feature/default");
		render({ currentProjectId: originalProject });
		expect(latest.sourceRef).toBe("task-a-review");
		render({ selectedCard: selection("other") });
		expect(latest.sourceRef).toBe("task-b-review");
		expect(latest.includeUncommitted).toBe(false);
	});

	it("follows changing defaults unless explicitly overridden and reset resumes following", () => {
		mocks.defaultSource = "feature/hydrated";
		render({ selectedCard: selection("task", 1, "develop") });
		expect(latest.sourceRef).toBe("feature/hydrated");
		expect(latest.targetRef).toBe("develop");
		act(() => {
			latest.setSourceRef("custom-source");
			latest.setTargetRef("custom-target");
		});
		mocks.defaultSource = "feature/refreshed";
		render({ selectedCard: selection("task", 1, "release") });
		expect(latest.sourceRef).toBe("custom-source");
		expect(latest.targetRef).toBe("custom-target");
		act(() => latest.resetToDefaults());
		expect(latest.sourceRef).toBe("feature/refreshed");
		expect(latest.targetRef).toBe("release");
		mocks.defaultSource = "feature/new-default";
		render({ selectedCard: selection("task", 1, "release") });
		expect(latest.sourceRef).toBe("feature/new-default");
		expect(latest.hasOverride).toBe(false);
	});

	it("external compare navigation takes precedence over retained refs and survives remount", () => {
		act(() => {
			latest.setSourceRef("old-source");
			latest.setTargetRef("old-target");
		});
		const consumed = vi.fn();
		render({ pendingNavigation: { sourceRef: "requested-source" }, onNavigationConsumed: consumed });
		expect(latest.sourceRef).toBe("requested-source");
		expect(latest.targetRef).toBe("old-target");
		expect(consumed).toHaveBeenCalledTimes(1);
		render({ pendingNavigation: null });
		act(() => root.render(null));
		render();
		expect(latest.sourceRef).toBe("requested-source");
		expect(latest.targetRef).toBe("old-target");
	});

	it("keeps explicit external refs pinned even when they initially match defaults", () => {
		render({ pendingNavigation: { sourceRef: "feature/default", targetRef: "main" } });
		render({ pendingNavigation: null });
		mocks.defaultSource = "feature/new-branch";
		render({ selectedCard: selection("task", 1, "develop") });
		expect(latest.sourceRef).toBe("feature/default");
		expect(latest.targetRef).toBe("main");
		act(() => latest.resetToDefaults());
		expect(latest.sourceRef).toBe("feature/new-branch");
		expect(latest.targetRef).toBe("develop");
	});

	it("retains options for an untouched scope when another scope changes shared defaults", () => {
		expect(latest.includeUncommitted).toBe(true);
		render({ selectedCard: selection("other") });
		act(() => latest.setIncludeUncommitted(false));
		expect(mocks.preferences.get(LocalStorageKey.CompareIncludeUncommitted)).toBe(false);
		render({ selectedCard: selection() });
		expect(latest.includeUncommitted).toBe(true);
	});
});
