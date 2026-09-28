import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RevertCommitAction } from "./revert-commit-action";

const mutate = vi.hoisted(() => vi.fn());
const toast = vi.hoisted(() => vi.fn());
vi.mock("@/runtime/trpc-client", () => ({ getRuntimeTrpcClient: () => ({ project: { revertCommit: { mutate } } }) }));
vi.mock("@/components/app-toaster", () => ({ showAppToast: toast }));

const commit = {
	hash: "a".repeat(40),
	shortHash: "aaaaaaa",
	message: "Add feature",
	parentHashes: ["b".repeat(40)],
	authorName: "User",
	authorEmail: "test@example.com",
	date: "2026-01-01",
};
const head = { name: "main", hash: "c".repeat(40), type: "branch" as const, isHead: true };

describe("RevertCommitAction", () => {
	let root: Root;
	let container: HTMLDivElement;
	const refresh = vi.fn();
	beforeEach(() => {
		container = document.createElement("div");
		document.body.append(container);
		root = createRoot(container);
		mutate.mockReset();
		toast.mockReset();
		refresh.mockReset();
	});
	afterEach(() => {
		act(() => root.unmount());
		container.remove();
	});
	function render(parentHashes = commit.parentHashes) {
		act(() =>
			root.render(
				<RevertCommitAction
					projectId="project-1"
					taskScope={{ taskId: "task-1", baseRef: "main" }}
					commit={{ ...commit, parentHashes }}
					headRef={head}
					onRefresh={refresh}
				/>,
			),
		);
	}
	async function click(text: string) {
		const button = Array.from(document.querySelectorAll("button")).find((node) => node.textContent === text);
		expect(button).toBeDefined();
		await act(async () => button!.click());
	}
	it("confirms the checked-out branch and sends its captured identity", async () => {
		mutate.mockResolvedValue({ ok: true });
		render();
		await click("Revert commit");
		expect(mutate).not.toHaveBeenCalled();
		expect(document.body.textContent).toContain("Existing history is preserved");
		await click("Create revert commit");
		expect(mutate).toHaveBeenCalledWith({
			commitHash: commit.hash,
			expectedHead: head.hash,
			expectedBranch: "main",
			taskScope: { taskId: "task-1", baseRef: "main" },
		});
		expect(refresh).toHaveBeenCalledOnce();
	});
	it("reports conflicts without claiming a completed revert", async () => {
		mutate.mockResolvedValue({ ok: false, conflictState: { operation: "revert", conflictedFiles: ["file.txt"] } });
		render();
		await click("Revert commit");
		await click("Create revert commit");
		expect(toast).toHaveBeenCalledWith(
			expect.objectContaining({ intent: "warning", message: expect.stringContaining("in progress") }),
		);
		expect(refresh).toHaveBeenCalledOnce();
	});
	it("keeps validation errors in the dialog and allows cancellation", async () => {
		mutate.mockResolvedValue({ ok: false, error: "Commit or stash your changes." });
		render();
		await click("Revert commit");
		await click("Create revert commit");
		expect(document.querySelector('[role="alert"]')?.textContent).toContain("Commit or stash");
		expect(refresh).not.toHaveBeenCalled();
		await click("Cancel");
		expect(document.querySelector('[role="dialog"]')).toBeNull();
	});
	it("shows the cause of a hook failure with no unresolved conflicts", async () => {
		mutate.mockResolvedValue({
			ok: false,
			error: "Synthetic commit check failed",
			conflictState: { operation: "revert", conflictedFiles: [] },
		});
		render();
		await click("Revert commit");
		await click("Create revert commit");
		expect(toast).toHaveBeenCalledWith(
			expect.objectContaining({
				intent: "warning",
				message: expect.stringContaining("Synthetic commit check failed"),
			}),
		);
	});
	it("disables ambiguous merge reverts", () => {
		render(["b".repeat(40), "d".repeat(40)]);
		expect(container.querySelector("button")?.disabled).toBe(true);
		expect(container.querySelector("button")?.title).toContain("mainline");
	});
});
