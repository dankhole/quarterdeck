import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
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
