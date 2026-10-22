import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import {
	clearCachedFileEditorTabs,
	getFileEditorDrafts,
	registerFileEditorScope,
	setCachedFileEditorTabs,
} from "@/hooks/git/file-editor-cache";
import { createFileEditorTab } from "@/hooks/git/file-editor-workspace";
import type { RuntimeClearTrashResult } from "@/runtime/types";
import { createTestProjectStateResponse } from "@/test-utils/task-session-factory";
import { type ClearTrash, useClearTrashOperation } from "./use-clear-trash-operation";

const mocks = vi.hoisted(() => ({ mutate: vi.fn(), client: vi.fn(), toast: vi.fn(), error: vi.fn() }));
vi.mock("@/runtime/trpc-client", () => ({
	getRuntimeTrpcClient: (projectId: string) => {
		mocks.client(projectId);
		return { runtime: { clearTrash: { mutate: mocks.mutate } } };
	},
}));
vi.mock("@/components/app-toaster", () => ({ showAppToast: mocks.toast, notifyError: mocks.error }));

it("keeps all task identities in the original project across navigation during flush and retries one ambiguous response", async () => {
	mocks.mutate.mockReset();
	mocks.client.mockReset();
	mocks.toast.mockReset();
	mocks.error.mockReset();
	let releaseFlush: () => void = () => {};
	const flush = new Promise<void>((resolve) => {
		releaseFlush = resolve;
	});
	let authoritativeProject = "one";
	let clear: ClearTrash = async () => null;
	const apply = vi.fn();
	const result: RuntimeClearTrashResult = {
		projectId: "one",
		state: createTestProjectStateResponse({ revision: 5 }),
		results: Array.from({ length: 12 }, (_, i) => ({
			taskId: `task-${i}`,
			taskCreatedAt: i,
			ok: i !== 11,
			outcomeCode: i === 11 ? "worktree_failed" : "completed",
		})),
	};
	mocks.mutate.mockRejectedValueOnce(new Error("Lost response")).mockResolvedValue(result);
	function Harness({ projectId }: { projectId: string }) {
		clear = useClearTrashOperation({
			currentProjectId: projectId,
			flushBoardCommands: async () => {
				await flush;
				return { ok: true };
			},
			getAuthoritativeRevision: () => (authoritativeProject === "one" ? 4 : 999),
			applyLifecycleProjectState: (state) => {
				if (authoritativeProject === projectId) apply(state);
			},
		});
		return null;
	}
	const container = document.createElement("div");
	const root = createRoot(container);
	try {
		await act(async () => {
			root.render(<Harness projectId="one" />);
		});
		let pending: Promise<RuntimeClearTrashResult | null> = Promise.resolve(null);
		await act(async () => {
			pending = clear(result.results.map(({ taskId, taskCreatedAt }) => ({ taskId, taskCreatedAt })));
		});
		authoritativeProject = "two";
		await act(async () => {
			root.render(<Harness projectId="two" />);
			releaseFlush();
			await pending;
		});
		expect(mocks.client).toHaveBeenCalledWith("one");
		expect(mocks.mutate).toHaveBeenCalledTimes(2);
		expect(mocks.mutate.mock.calls[0]?.[0]).toEqual(mocks.mutate.mock.calls[1]?.[0]);
		expect(mocks.mutate.mock.calls[0]?.[0].tasks).toHaveLength(12);
		expect(mocks.mutate.mock.calls[0]?.[0].expectedRevision).toBe(4);
		expect(apply).not.toHaveBeenCalled();
		expect(mocks.error).not.toHaveBeenCalled();
		expect(mocks.toast).toHaveBeenCalledTimes(2);
		expect(mocks.toast.mock.calls[1]?.[0]).toMatchObject({
			intent: "warning",
			message: "Deleted 11 tasks. Could not confirm deletion of 1 task; check Trash before retrying.",
		});
	} finally {
		await act(async () => root.unmount());
	}
});

it("blocks Clear Trash on hidden drafts and preserves them for review", async () => {
	mocks.mutate.mockClear();
	registerFileEditorScope("hidden-trash", { projectId: "one", taskId: "task-1", taskCreatedAt: 1 });
	const tab = createFileEditorTab("app.ts", {
		content: "disk",
		contentHash: "hash",
		language: "typescript",
		binary: false,
		truncated: false,
		size: 4,
	});
	setCachedFileEditorTabs("hidden-trash", [{ ...tab, value: "unsaved" }]);
	let clear: ClearTrash = async () => null;
	const flush = vi.fn(async () => ({ ok: true }));
	function Harness() {
		clear = useClearTrashOperation({
			currentProjectId: "one",
			flushBoardCommands: flush,
			getAuthoritativeRevision: () => 1,
			applyLifecycleProjectState: vi.fn(),
		});
		return null;
	}
	const root = createRoot(document.createElement("div"));
	try {
		await act(async () => root.render(<Harness />));
		await act(async () => {
			expect(await clear([{ taskId: "task-1", taskCreatedAt: 1 }])).toBeNull();
		});
		expect(flush).not.toHaveBeenCalled();
		expect(mocks.mutate).not.toHaveBeenCalled();
		expect(getFileEditorDrafts()[0]?.tab.value).toBe("unsaved");
	} finally {
		await act(async () => root.unmount());
		clearCachedFileEditorTabs();
	}
});

it("waits (bounded) for the first authoritative revision instead of failing instantly", async () => {
	vi.useFakeTimers();
	try {
		mocks.mutate.mockReset();
		mocks.client.mockReset();
		mocks.toast.mockReset();
		mocks.error.mockReset();
		let revision: number | null = null;
		mocks.mutate.mockResolvedValue({
			projectId: "proj-1",
			state: createTestProjectStateResponse({ revision: 9 }),
			results: [{ taskId: "task-1", taskCreatedAt: 1, ok: true, outcomeCode: "completed" }],
		});
		let clear: ClearTrash = async () => null;
		function Harness() {
			clear = useClearTrashOperation({
				currentProjectId: "proj-1",
				flushBoardCommands: async () => ({ ok: true }),
				getAuthoritativeRevision: () => revision,
				applyLifecycleProjectState: vi.fn(),
			});
			return null;
		}
		const root = createRoot(document.createElement("div"));
		try {
			await act(async () => root.render(<Harness />));
			let pending: Promise<RuntimeClearTrashResult | null> | null = null;
			await act(async () => {
				pending = clear([{ taskId: "task-1", taskCreatedAt: 1 }]);
			});
			expect(mocks.mutate).not.toHaveBeenCalled();

			revision = 4;
			await act(async () => {
				await vi.advanceTimersByTimeAsync(250);
				await pending;
			});
			expect(mocks.mutate).toHaveBeenCalledOnce();
			expect(mocks.mutate.mock.calls[0]?.[0].expectedRevision).toBe(4);
		} finally {
			await act(async () => root.unmount());
		}
	} finally {
		vi.useRealTimers();
	}
});

it("includes the project name in the toast and replaces it with a non-error status update after the still-running deadline", async () => {
	vi.useFakeTimers();
	try {
		mocks.mutate.mockReset();
		mocks.client.mockReset();
		mocks.toast.mockReset();
		mocks.error.mockReset();
		let resolveMutate: ((result: RuntimeClearTrashResult) => void) | null = null;
		mocks.mutate.mockImplementation(
			() =>
				new Promise<RuntimeClearTrashResult>((resolve) => {
					resolveMutate = resolve;
				}),
		);
		let clear: ClearTrash = async () => null;
		function Harness() {
			clear = useClearTrashOperation({
				currentProjectId: "proj-1",
				projectName: "Acme Web",
				flushBoardCommands: async () => ({ ok: true }),
				getAuthoritativeRevision: () => 4,
				applyLifecycleProjectState: vi.fn(),
			});
			return null;
		}
		const root = createRoot(document.createElement("div"));
		try {
			await act(async () => root.render(<Harness />));
			let pending: Promise<RuntimeClearTrashResult | null> = Promise.resolve(null);
			await act(async () => {
				pending = clear([{ taskId: "task-1", taskCreatedAt: 1 }]);
			});
			expect(mocks.toast).toHaveBeenCalledWith(
				expect.objectContaining({ message: expect.stringContaining("Acme Web") }),
				expect.any(String),
			);
			const toastKey = mocks.toast.mock.calls[0]?.[1];

			await act(async () => {
				await vi.advanceTimersByTimeAsync(60_000);
			});
			expect(mocks.toast).toHaveBeenLastCalledWith(
				{ message: "Still clearing in Acme Web — check Trash.", timeout: Infinity },
				toastKey,
			);

			const result: RuntimeClearTrashResult = {
				projectId: "proj-1",
				state: createTestProjectStateResponse({ revision: 5 }),
				results: [{ taskId: "task-1", taskCreatedAt: 1, ok: true, outcomeCode: "completed" }],
			};
			await act(async () => {
				resolveMutate?.(result);
				await pending;
			});
			expect(mocks.toast).toHaveBeenLastCalledWith(expect.objectContaining({ intent: "success" }), toastKey);
		} finally {
			await act(async () => root.unmount());
		}
	} finally {
		vi.useRealTimers();
	}
});
