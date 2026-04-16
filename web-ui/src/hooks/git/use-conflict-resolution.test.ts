import { act, createElement, useEffect } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { UseConflictResolutionResult } from "@/hooks/git/use-conflict-resolution";
import type { RuntimeConflictState } from "@/runtime/types";

// ---------------------------------------------------------------------------
// Mocks — hoisted so they are available before any imports run.
// ---------------------------------------------------------------------------

const useConflictStateMock = vi.hoisted(() => vi.fn((_taskId: string | null) => null as RuntimeConflictState | null));
const useHomeConflictStateMock = vi.hoisted(() => vi.fn(() => null as RuntimeConflictState | null));

vi.mock("@/stores/workspace-metadata-store", () => ({
	useConflictState: useConflictStateMock,
	useHomeConflictState: useHomeConflictStateMock,
}));

const resolveConflictFileMutateMock = vi.hoisted(() => vi.fn(async () => ({ ok: true })));
const continueConflictResolutionMutateMock = vi.hoisted(() =>
	vi.fn(async () => ({
		ok: true,
		completed: true,
		summary: {
			currentBranch: null,
			upstreamBranch: null,
			changedFiles: 0,
			additions: 0,
			deletions: 0,
			aheadCount: 0,
			behindCount: 0,
		},
		output: "",
	})),
);
const abortConflictResolutionMutateMock = vi.hoisted(() =>
	vi.fn(async () => ({
		ok: true,
		summary: {
			currentBranch: null,
			upstreamBranch: null,
			changedFiles: 0,
			additions: 0,
			deletions: 0,
			aheadCount: 0,
			behindCount: 0,
		},
	})),
);
const getConflictFilesMutateMock = vi.hoisted(() => vi.fn(async () => ({ ok: true, files: [] })));

vi.mock("@/runtime/trpc-client", () => ({
	getRuntimeTrpcClient: () => ({
		workspace: {
			resolveConflictFile: { mutate: resolveConflictFileMutateMock },
			continueConflictResolution: { mutate: continueConflictResolutionMutateMock },
			abortConflictResolution: { mutate: abortConflictResolutionMutateMock },
			getConflictFiles: { mutate: getConflictFilesMutateMock },
		},
	}),
}));

// ---------------------------------------------------------------------------
// Import the hook under test (after mocks are installed).
// ---------------------------------------------------------------------------

import { useConflictResolution } from "@/hooks/git/use-conflict-resolution";

// ---------------------------------------------------------------------------
// Test fixtures.
// ---------------------------------------------------------------------------

function createConflictState(overrides: Partial<RuntimeConflictState> = {}): RuntimeConflictState {
	return {
		operation: "merge",
		sourceBranch: "feature/test",
		currentStep: null,
		totalSteps: null,
		conflictedFiles: ["src/foo.ts", "src/bar.ts"],
		autoMergedFiles: [],
		...overrides,
	};
}

// ---------------------------------------------------------------------------
// Harness — captures the latest hook return value via an `onSnapshot` callback.
// ---------------------------------------------------------------------------

function HookHarness({
	taskId,
	workspaceId,
	onSnapshot,
}: {
	taskId: string | null;
	workspaceId: string | null;
	onSnapshot: (snapshot: UseConflictResolutionResult) => void;
}): null {
	const result = useConflictResolution({ taskId, workspaceId });
	useEffect(() => {
		onSnapshot(result);
	});
	return null;
}

// ---------------------------------------------------------------------------
// Tests.
// ---------------------------------------------------------------------------

describe("useConflictResolution", () => {
	let container: HTMLDivElement;
	let root: Root;
	let latest: UseConflictResolutionResult;
	let previousActEnvironment: boolean | undefined;

	beforeEach(() => {
		previousActEnvironment = (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean })
			.IS_REACT_ACT_ENVIRONMENT;
		(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

		container = document.createElement("div");
		document.body.appendChild(container);
		root = createRoot(container);

		resolveConflictFileMutateMock.mockClear();
		continueConflictResolutionMutateMock.mockClear();
		abortConflictResolutionMutateMock.mockClear();
		getConflictFilesMutateMock.mockClear();
		useConflictStateMock.mockReset();
		useHomeConflictStateMock.mockReset();

		// Default: no conflict state.
		useConflictStateMock.mockReturnValue(null);
		useHomeConflictStateMock.mockReturnValue(null);
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

	function render(props: { taskId?: string | null; workspaceId?: string | null } = {}): void {
		act(() => {
			root.render(
				createElement(HookHarness, {
					taskId: props.taskId ?? "task-1",
					workspaceId: props.workspaceId ?? "ws-1",
					onSnapshot: (snapshot: UseConflictResolutionResult) => {
						latest = snapshot;
					},
				}),
			);
		});
	}

	// -----------------------------------------------------------------------
	// 1. isActive is false when no conflict state
	// -----------------------------------------------------------------------
	it("isActive is false when no conflict state", () => {
		render();
		expect(latest.isActive).toBe(false);
		expect(latest.conflictState).toBeNull();
	});

	// -----------------------------------------------------------------------
	// 2. isActive is true when conflict state present
	// -----------------------------------------------------------------------
	it("isActive is true when conflict state present", () => {
		const conflictState = createConflictState();
		useConflictStateMock.mockReturnValue(conflictState);

		render();
		expect(latest.isActive).toBe(true);
		expect(latest.conflictState).toBe(conflictState);
	});

	// -----------------------------------------------------------------------
	// 3. resolveFile calls trpc mutation
	// -----------------------------------------------------------------------
	it("resolveFile calls trpc mutation", async () => {
		useConflictStateMock.mockReturnValue(createConflictState());
		render();

		await act(async () => {
			const result = await latest.resolveFile("src/foo.ts", "ours");
			expect(result).toEqual({ ok: true });
		});

		expect(resolveConflictFileMutateMock).toHaveBeenCalledWith({
			taskId: "task-1",
			path: "src/foo.ts",
			resolution: "ours",
		});
	});

	// -----------------------------------------------------------------------
	// 4. continueResolution calls trpc mutation
	// -----------------------------------------------------------------------
	it("continueResolution calls trpc mutation", async () => {
		useConflictStateMock.mockReturnValue(createConflictState());
		render();

		await act(async () => {
			await latest.continueResolution();
		});

		expect(continueConflictResolutionMutateMock).toHaveBeenCalledWith({
			taskId: "task-1",
		});
	});

	// -----------------------------------------------------------------------
	// 5. abortResolution calls trpc mutation
	// -----------------------------------------------------------------------
	it("abortResolution calls trpc mutation", async () => {
		useConflictStateMock.mockReturnValue(createConflictState());
		render();

		await act(async () => {
			await latest.abortResolution();
		});

		expect(abortConflictResolutionMutateMock).toHaveBeenCalledWith({
			taskId: "task-1",
		});
	});

	// -----------------------------------------------------------------------
	// 6. resolvedFiles resets when currentStep changes
	// -----------------------------------------------------------------------
	it("resolvedFiles resets when currentStep changes", async () => {
		// Start with a rebase at step 1.
		const initialState = createConflictState({
			operation: "rebase",
			currentStep: 1,
			totalSteps: 3,
			conflictedFiles: ["src/foo.ts"],
		});
		useConflictStateMock.mockReturnValue(initialState);
		render();

		// Resolve a file so resolvedFiles is non-empty.
		await act(async () => {
			await latest.resolveFile("src/foo.ts", "ours");
		});
		expect(latest.resolvedFiles.has("src/foo.ts")).toBe(true);

		// Advance to step 2 — resolvedFiles should reset.
		const step2State = createConflictState({
			operation: "rebase",
			currentStep: 2,
			totalSteps: 3,
			conflictedFiles: ["src/bar.ts"],
		});
		useConflictStateMock.mockReturnValue(step2State);

		act(() => {
			root.render(
				createElement(HookHarness, {
					taskId: "task-1",
					workspaceId: "ws-1",
					onSnapshot: (snapshot: UseConflictResolutionResult) => {
						latest = snapshot;
					},
				}),
			);
		});

		expect(latest.resolvedFiles.size).toBe(0);
	});
});
