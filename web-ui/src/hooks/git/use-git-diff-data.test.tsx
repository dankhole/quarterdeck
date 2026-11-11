import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RuntimeWorkdirChangesResponse } from "@/runtime/types";
import { type UseGitDiffDataOptions, type UseGitDiffDataResult, useGitDiffData } from "./use-git-diff-data";

const mocks = vi.hoisted(() => ({ changes: vi.fn(), file: vi.fn(), visible: false }));
vi.mock("@/runtime/trpc-client", () => ({
	getRuntimeTrpcClient: () => ({
		project: {
			getChanges: { query: mocks.changes },
			getFileDiff: { query: mocks.file },
		},
	}),
}));
vi.mock("@/hooks/notifications/use-document-visibility", () => ({ useDocumentVisibility: () => mocks.visible }));
vi.mock("@/stores/project-metadata-store", () => ({ useTaskWorktreeStateVersionValue: () => 0 }));

function deferred<T>() {
	let resolve!: (value: T) => void;
	let reject!: (error: Error) => void;
	const promise = new Promise<T>((yes, no) => {
		resolve = yes;
		reject = no;
	});
	return { promise, resolve, reject };
}
function metadata(revision: string, generatedAt: number): RuntimeWorkdirChangesResponse {
	return {
		repoRoot: "/repo",
		generatedAt,
		files: [
			{
				path: "a.ts",
				status: "modified",
				additions: 1,
				deletions: 1,
				oldText: null,
				newText: null,
				contentRevision: revision,
			},
		],
	};
}
function options(): UseGitDiffDataOptions {
	return {
		activeTab: "compare",
		currentProjectId: "p1",
		taskId: "task-1",
		baseRef: "main",
		selectedPath: "a.ts",
		visibleDiffPaths: ["a.ts"],
		compare: {
			sourceRef: "topic",
			targetRef: "main",
			defaultSourceRef: "topic",
			defaultTargetRef: "main",
			setSourceRef: vi.fn(),
			setTargetRef: vi.fn(),
			resetToDefaults: vi.fn(),
			isBrowsing: false,
			hasOverride: false,
			branches: [],
			worktreeBranches: new Map(),
			includeUncommitted: false,
			setIncludeUncommitted: vi.fn(),
			threeDotDiff: true,
			setThreeDotDiff: vi.fn(),
		},
	};
}

describe("useGitDiffData", () => {
	let root: Root;
	let result: UseGitDiffDataResult;
	let input: UseGitDiffDataOptions;
	let previousActEnvironment: boolean | undefined;
	function Harness({ options }: { options: UseGitDiffDataOptions }) {
		result = useGitDiffData(options);
		return null;
	}
	async function render(next = input) {
		await act(async () => root.render(<Harness options={next} />));
	}
	beforeEach(() => {
		previousActEnvironment = (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
		(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
		vi.clearAllMocks();
		mocks.visible = false;
		input = options();
		root = createRoot(document.createElement("div"));
		mocks.changes.mockReset().mockResolvedValue(metadata("r1", 1));
		mocks.file.mockReset().mockResolvedValue({ oldText: "base", newText: "first" });
	});
	afterEach(async () => {
		await act(async () => root.unmount());
		vi.useRealTimers();
		(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = previousActEnvironment;
	});

	it.each(["uncommitted", "compare"] as const)(
		"keeps the empty %s review visible throughout background polling and applies new changes",
		async (activeTab) => {
			vi.useFakeTimers();
			mocks.visible = true;
			input = { ...input, activeTab, compare: { ...input.compare, includeUncommitted: true } };
			const empty: RuntimeWorkdirChangesResponse = { repoRoot: "/repo", generatedAt: 1, files: [] };
			mocks.changes.mockResolvedValue(empty);
			await render();
			expect(result.hasNoChanges).toBe(true);

			const poll = deferred<RuntimeWorkdirChangesResponse>();
			mocks.changes.mockReturnValueOnce(poll.promise);
			await act(async () => {
				vi.advanceTimersByTime(1_000);
			});
			expect(mocks.changes).toHaveBeenCalledTimes(2);
			expect(result.isRefreshing).toBe(true);
			expect(result.isChangesPending).toBe(false);
			expect(result.hasNoChanges).toBe(true);
			await act(async () => poll.resolve({ ...empty, generatedAt: 2 }));
			expect(result.isRefreshing).toBe(false);
			expect(result.hasNoChanges).toBe(true);

			const nextPoll = deferred<RuntimeWorkdirChangesResponse>();
			mocks.changes.mockReturnValueOnce(nextPoll.promise);
			await act(async () => {
				vi.advanceTimersByTime(1_000);
			});
			expect(result.hasNoChanges).toBe(true);
			await act(async () => nextPoll.resolve(metadata("r2", 3)));
			expect(result.hasNoChanges).toBe(false);
			expect(result.enrichedFiles?.[0]?.newText).toBe("first");
		},
	);

	it("shows pending rather than an empty review until the initial query and a new comparison resolve", async () => {
		const initial = deferred<RuntimeWorkdirChangesResponse>();
		mocks.changes.mockReturnValueOnce(initial.promise);
		await render();
		expect(result.hasNoChanges).toBe(false);
		expect(result.isChangesPending).toBe(true);
		await act(async () => initial.resolve({ repoRoot: "/repo", generatedAt: 1, files: [] }));
		expect(result.hasNoChanges).toBe(true);

		const comparison = deferred<RuntimeWorkdirChangesResponse>();
		mocks.changes.mockReturnValueOnce(comparison.promise);
		await render({ ...input, compare: { ...input.compare, targetRef: "other-base" } });
		expect(result.hasNoChanges).toBe(false);
		expect(result.isChangesPending).toBe(true);
		await act(async () => comparison.resolve(metadata("r2", 2)));
		expect(result.hasNoChanges).toBe(false);
		expect(result.enrichedFiles?.[0]?.newText).toBe("first");
	});

	it("refreshes moving committed refs through metadata and file owners without changing refs or clearing loaded content", async () => {
		await render();
		expect(result.enrichedFiles?.[0]?.newText).toBe("first");
		const response = deferred<RuntimeWorkdirChangesResponse>();
		mocks.changes.mockReturnValueOnce(response.promise);
		mocks.file.mockResolvedValueOnce({ oldText: "base", newText: "moved" });
		let refreshing!: Promise<void>;
		await act(async () => {
			refreshing = result.refresh();
		});
		expect(result.isRefreshing).toBe(true);
		expect(result.isChangesPending).toBe(false);
		expect(result.enrichedFiles?.[0]?.newText).toBe("first");
		await act(async () => {
			response.resolve(metadata("r2", 2));
			await refreshing;
		});
		expect(result.isRefreshing).toBe(false);
		expect(result.enrichedFiles?.[0]?.newText).toBe("moved");
		expect(mocks.changes).toHaveBeenLastCalledWith({
			taskId: "task-1",
			baseRef: "main",
			mode: "working_copy",
			fromRef: "main",
			toRef: "topic",
			diffMode: "three_dot",
		});
		expect(mocks.file).toHaveBeenLastCalledWith(
			expect.objectContaining({ path: "a.ts", fromRef: "main", toRef: "topic", diffMode: "three_dot" }),
		);
		expect(input.selectedPath).toBe("a.ts");
	});

	it("reports failed metadata refresh as an error, retains the old snapshot, and recovers explicitly", async () => {
		await render();
		mocks.changes.mockRejectedValueOnce(new Error("unknown ref"));
		await act(async () => {
			await result.refresh();
		});
		expect(result.changesError).toBe("unknown ref");
		expect(result.isRuntimeAvailable).toBe(false);
		expect(result.hasNoChanges).toBe(false);
		expect(result.enrichedFiles?.[0]?.newText).toBe("first");
		mocks.changes.mockResolvedValueOnce({ repoRoot: "/repo", generatedAt: 3, files: [] });
		await act(async () => {
			await result.refresh();
		});
		expect(result.changesError).toBeNull();
		expect(result.hasNoChanges).toBe(true);
		expect(result.enrichedFiles).toEqual([]);
	});

	it("never classifies an initial metadata failure as an empty review", async () => {
		mocks.changes.mockRejectedValueOnce(new Error("Git unavailable"));
		await render();
		expect(result.changesError).toBe("Git unavailable");
		expect(result.hasNoChanges).toBe(false);
		expect(result.isChangesPending).toBe(false);
		expect(result.activeFiles).toBeNull();
	});

	it("lets an explicit refresh retry failed file content even when metadata equality is unchanged", async () => {
		mocks.file.mockRejectedValueOnce(new Error("file unavailable"));
		await render();
		expect(result.fileLoadingState.errors?.get("a.ts")).toBe("file unavailable");
		mocks.changes.mockResolvedValueOnce(metadata("r1", 2));
		await act(async () => {
			await result.refresh();
		});
		expect(mocks.file).toHaveBeenCalledTimes(2);
		expect(result.enrichedFiles?.[0]?.newText).toBe("first");
		expect(result.fileLoadingState.errors?.has("a.ts")).toBe(false);
	});

	it("fences a late refresh from the old comparison after refs change", async () => {
		await render();
		const old = deferred<RuntimeWorkdirChangesResponse>();
		mocks.changes.mockReturnValueOnce(old.promise);
		let refreshing!: Promise<void>;
		await act(async () => {
			refreshing = result.refresh();
		});
		mocks.changes.mockResolvedValueOnce(metadata("new-context", 3));
		mocks.file.mockResolvedValueOnce({ oldText: "new base", newText: "new context" });
		await render({ ...input, compare: { ...input.compare, sourceRef: "other-topic" } });
		await act(async () => {
			old.resolve(metadata("late-old-context", 4));
			await refreshing;
		});
		expect(result.activeFiles?.[0]?.contentRevision).toBe("new-context");
		expect(result.enrichedFiles?.[0]?.newText).toBe("new context");
		expect(result.changesError).toBeNull();
	});

	it("refreshes Uncommitted with working-copy semantics and includes untracked metadata", async () => {
		input = { ...input, activeTab: "uncommitted" };
		await render();
		mocks.changes.mockResolvedValueOnce({
			repoRoot: "/repo",
			generatedAt: 2,
			files: [{ path: "new.ts", status: "untracked", additions: 1, deletions: 0, oldText: null, newText: null }],
		});
		await act(async () => {
			await result.refresh();
		});
		expect(mocks.changes).toHaveBeenLastCalledWith({ taskId: "task-1", baseRef: "main", mode: "working_copy" });
		expect(result.activeFiles?.[0]).toMatchObject({ path: "new.ts", status: "untracked" });
	});
});
