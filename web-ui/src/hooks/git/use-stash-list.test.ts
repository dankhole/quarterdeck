import { act, createElement, useEffect } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { UseStashListResult } from "@/hooks/git/use-stash-list";

// ---------------------------------------------------------------------------
// Mocks — hoisted so they are available before any imports run.
// ---------------------------------------------------------------------------

const homeStashCountMock = vi.hoisted(() => ({ value: 0 }));

vi.mock("@/stores/project-metadata-store", () => ({
	useTaskWorktreeInfoValue: () => ({ baseRef: "main" }),
	useHomeStashCount: () => homeStashCountMock.value,
}));

const stashListQueryMock = vi.hoisted(() =>
	vi.fn(async () => ({
		ok: true as boolean,
		entries: [] as Array<{ index: number; message: string; branch: string; date: string }>,
	})),
);
const stashPopMutateMock = vi.hoisted(() => vi.fn(async () => ({ ok: true, conflicted: false })));
const stashApplyMutateMock = vi.hoisted(() => vi.fn(async () => ({ ok: true, conflicted: false })));
const stashDropMutateMock = vi.hoisted(() => vi.fn(async () => ({ ok: true })));
const stashShowQueryMock = vi.hoisted(() => vi.fn(async () => ({ ok: true, diff: "" })));

vi.mock("@/runtime/trpc-client", () => ({
	getRuntimeTrpcClient: () => ({
		project: {
			stashList: { query: stashListQueryMock },
			stashPop: { mutate: stashPopMutateMock },
			stashApply: { mutate: stashApplyMutateMock },
			stashDrop: { mutate: stashDropMutateMock },
			stashShow: { query: stashShowQueryMock },
		},
	}),
}));

vi.mock("@/components/app-toaster", () => ({
	showAppToast: vi.fn(),
}));

// ---------------------------------------------------------------------------
// Import the hook under test (after mocks are installed).
// ---------------------------------------------------------------------------

import { useStashList } from "@/hooks/git/use-stash-list";

// ---------------------------------------------------------------------------
// Test fixtures.
// ---------------------------------------------------------------------------

const mockEntry0 = { index: 0, message: "WIP: feature A", branch: "main", date: "2026-04-12T10:00:00Z" };
const mockEntry1 = { index: 1, message: "WIP: fix B", branch: "main", date: "2026-04-12T09:00:00Z" };
const mockEntries = [mockEntry0, mockEntry1];

// ---------------------------------------------------------------------------
// Harness — captures the latest hook return value via an `onSnapshot` callback.
// ---------------------------------------------------------------------------

function HookHarness({
	taskId,
	projectId,
	onSnapshot,
}: {
	taskId: string | undefined;
	projectId: string;
	onSnapshot: (snapshot: UseStashListResult) => void;
}): null {
	const result = useStashList(taskId, projectId);
	useEffect(() => {
		onSnapshot(result);
	});
	return null;
}

// ---------------------------------------------------------------------------
// Tests.
// ---------------------------------------------------------------------------

describe("useStashList", () => {
	let container: HTMLDivElement;
	let root: Root;
	let latest: UseStashListResult;
	let previousActEnvironment: boolean | undefined;

	beforeEach(() => {
		previousActEnvironment = (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean })
			.IS_REACT_ACT_ENVIRONMENT;
		(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

		container = document.createElement("div");
		document.body.appendChild(container);
		root = createRoot(container);

		stashListQueryMock.mockClear();
		stashPopMutateMock.mockClear();
		stashApplyMutateMock.mockClear();
		stashDropMutateMock.mockClear();
		stashShowQueryMock.mockClear();
		homeStashCountMock.value = 0;

		// Default: return two mock entries.
		stashListQueryMock.mockResolvedValue({ ok: true, entries: mockEntries });
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

	function render(props: { taskId?: string | undefined; projectId?: string } = {}): void {
		act(() => {
			root.render(
				createElement(HookHarness, {
					taskId: props.taskId ?? "task-1",
					projectId: props.projectId ?? "ws-1",
					onSnapshot: (snapshot: UseStashListResult) => {
						latest = snapshot;
					},
				}),
			);
		});
	}

	// -----------------------------------------------------------------------
	// Helper: flush all pending promises so async effects settle.
	// -----------------------------------------------------------------------
	async function flush(): Promise<void> {
		await act(async () => {
			await new Promise((r) => setTimeout(r, 0));
		});
	}

	// -----------------------------------------------------------------------
	// 1. fetches stash list on mount when expanded
	// -----------------------------------------------------------------------
	it("fetches stash list on mount when expanded", async () => {
		render();

		// Initially not expanded — no fetch.
		expect(stashListQueryMock).not.toHaveBeenCalled();
		expect(latest.entries).toEqual([]);

		// Expand the stash list section.
		act(() => {
			latest.setExpanded(true);
		});
		await flush();

		expect(stashListQueryMock).toHaveBeenCalledTimes(1);
		expect(stashListQueryMock).toHaveBeenCalledWith({
			taskScope: { taskId: "task-1", baseRef: "main" },
		});
		expect(latest.entries).toEqual(mockEntries);
	});

	// -----------------------------------------------------------------------
	// 2. refetches when stash count changes
	// -----------------------------------------------------------------------
	it("refetches when stash count changes", async () => {
		render();

		// Expand to trigger initial fetch.
		act(() => {
			latest.setExpanded(true);
		});
		await flush();
		expect(stashListQueryMock).toHaveBeenCalledTimes(1);

		// Simulate stash count changing in the metadata store.
		stashListQueryMock.mockResolvedValue({ ok: true, entries: [mockEntry0] });
		homeStashCountMock.value = 1;

		// Re-render to pick up the new stash count.
		act(() => {
			root.render(
				createElement(HookHarness, {
					taskId: "task-1",
					projectId: "ws-1",
					onSnapshot: (snapshot: UseStashListResult) => {
						latest = snapshot;
					},
				}),
			);
		});
		await flush();

		expect(stashListQueryMock).toHaveBeenCalledTimes(2);
		expect(latest.entries).toEqual([mockEntry0]);
	});

	// -----------------------------------------------------------------------
	// 3. popStash calls tRPC and refetches
	// -----------------------------------------------------------------------
	it("popStash calls tRPC and refetches", async () => {
		render();

		// Expand to trigger initial fetch.
		act(() => {
			latest.setExpanded(true);
		});
		await flush();
		expect(stashListQueryMock).toHaveBeenCalledTimes(1);

		// Pop stash at index 0.
		stashListQueryMock.mockResolvedValue({ ok: true, entries: [mockEntry1] });
		await act(async () => {
			await latest.popStash(0);
		});
		await flush();

		expect(stashPopMutateMock).toHaveBeenCalledTimes(1);
		expect(stashPopMutateMock).toHaveBeenCalledWith({
			taskScope: { taskId: "task-1", baseRef: "main" },
			index: 0,
		});
		// Should refetch after pop.
		expect(stashListQueryMock).toHaveBeenCalledTimes(2);
		expect(latest.entries).toEqual([mockEntry1]);
	});

	// -----------------------------------------------------------------------
	// 4. applyStash calls tRPC and refetches
	// -----------------------------------------------------------------------
	it("applyStash calls tRPC and refetches", async () => {
		render();

		// Expand to trigger initial fetch.
		act(() => {
			latest.setExpanded(true);
		});
		await flush();
		expect(stashListQueryMock).toHaveBeenCalledTimes(1);

		// Apply stash at index 0.
		await act(async () => {
			await latest.applyStash(0);
		});
		await flush();

		expect(stashApplyMutateMock).toHaveBeenCalledTimes(1);
		expect(stashApplyMutateMock).toHaveBeenCalledWith({
			taskScope: { taskId: "task-1", baseRef: "main" },
			index: 0,
		});
		// Should refetch after apply.
		expect(stashListQueryMock).toHaveBeenCalledTimes(2);
	});

	// -----------------------------------------------------------------------
	// 5. dropStash calls tRPC and refetches
	// -----------------------------------------------------------------------
	it("dropStash calls tRPC and refetches", async () => {
		render();

		// Expand to trigger initial fetch.
		act(() => {
			latest.setExpanded(true);
		});
		await flush();
		expect(stashListQueryMock).toHaveBeenCalledTimes(1);

		// Drop stash at index 1.
		stashListQueryMock.mockResolvedValue({ ok: true, entries: [mockEntry0] });
		await act(async () => {
			await latest.dropStash(1);
		});
		await flush();

		expect(stashDropMutateMock).toHaveBeenCalledTimes(1);
		expect(stashDropMutateMock).toHaveBeenCalledWith({
			taskScope: { taskId: "task-1", baseRef: "main" },
			index: 1,
		});
		// Should refetch after drop.
		expect(stashListQueryMock).toHaveBeenCalledTimes(2);
		expect(latest.entries).toEqual([mockEntry0]);
	});
});
