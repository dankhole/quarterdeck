import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type UseBranchActionsResult, useBranchActions } from "@/hooks/git/use-branch-actions";
import type { RuntimeGitCheckoutResponse, RuntimeGitSyncSummary, RuntimeStashPushResponse } from "@/runtime/types";
import {
	getHomeGitStateVersion,
	resetProjectMetadataStore,
	setHomeGitSummary,
	setProjectMetadataScope,
	setProjectPath,
	useHomeGitSummaryValue,
} from "@/stores/project-metadata-store";
import type { BoardData } from "@/types";

const checkoutMutate = vi.hoisted(() => vi.fn<() => Promise<RuntimeGitCheckoutResponse>>());
const stashPushMutate = vi.hoisted(() => vi.fn<() => Promise<RuntimeStashPushResponse>>());
const showAppToast = vi.hoisted(() => vi.fn());

vi.mock("@/runtime/trpc-client", () => ({
	getRuntimeTrpcClient: () => ({
		project: { checkoutGitBranch: { mutate: checkoutMutate }, stashPush: { mutate: stashPushMutate } },
	}),
}));

vi.mock("@/components/app-toaster", () => ({ showAppToast }));

const board: BoardData = { columns: [] };
const selectBranchView = vi.fn();
const onCheckoutSuccess = vi.fn();

interface CheckoutSnapshot {
	checkout: (branch: string) => Promise<void> | void;
	summary: RuntimeGitSyncSummary | null;
	currentBranch: string | null;
	branchActions: UseBranchActionsResult;
}

interface HarnessProps {
	projectId: string;
	onSnapshot: (snapshot: CheckoutSnapshot) => void;
	taskScope?: { taskId: string; baseRef: string };
}

function BranchActionsHarness({ projectId, onSnapshot, taskScope }: HarnessProps): null {
	const summary = useHomeGitSummaryValue();
	const actions = useBranchActions({
		projectId,
		board,
		selectBranchView,
		homeGitSummary: summary,
		taskId: taskScope?.taskId,
		baseRef: taskScope?.baseRef,
		taskBranch: taskScope ? summary?.currentBranch : undefined,
		taskChangedFiles: taskScope ? summary?.changedFiles : undefined,
		onCheckoutSuccess,
	});
	onSnapshot({
		checkout: (branch) => actions.handleConfirmCheckout(branch, "home"),
		summary,
		currentBranch: actions.currentBranch,
		branchActions: actions,
	});
	return null;
}

function createSummary(branch: string): RuntimeGitSyncSummary {
	return {
		currentBranch: branch,
		upstreamBranch: `origin/${branch}`,
		changedFiles: 3,
		additions: 7,
		deletions: 2,
		aheadCount: 1,
		behindCount: 4,
	};
}

function createCheckoutResponse(summary: RuntimeGitSyncSummary, ok = true): RuntimeGitCheckoutResponse {
	return {
		ok,
		branch: "feature/new",
		summary,
		output: "",
		...(!ok ? { error: "Post-checkout hook failed." } : {}),
	};
}

function deferredCheckout(): {
	promise: Promise<RuntimeGitCheckoutResponse>;
	resolve: (response: RuntimeGitCheckoutResponse) => void;
} {
	let resolve!: (response: RuntimeGitCheckoutResponse) => void;
	const promise = new Promise<RuntimeGitCheckoutResponse>((resolvePromise) => {
		resolve = resolvePromise;
	});
	return { promise, resolve };
}

describe("branch selector checkout", () => {
	let root: Root;
	let snapshot: CheckoutSnapshot;
	let previousActEnvironment: boolean | undefined;
	const knownSummary = createSummary("feature/current");

	beforeEach(() => {
		previousActEnvironment = (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean })
			.IS_REACT_ACT_ENVIRONMENT;
		(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
		root = createRoot(document.createElement("div"));
		resetProjectMetadataStore();
		setProjectMetadataScope("project-a");
		setProjectPath("project-a", "/repo/a");
		setHomeGitSummary("project-a", knownSummary);
		vi.clearAllMocks();
		checkoutMutate.mockReset();
		stashPushMutate.mockReset();
	});

	afterEach(() => {
		act(() => root.unmount());
		resetProjectMetadataStore();
		if (previousActEnvironment === undefined) {
			delete (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
		} else {
			(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
				previousActEnvironment;
		}
	});

	function render(projectId = "project-a"): void {
		act(() => {
			root.render(
				<BranchActionsHarness
					projectId={projectId}
					onSnapshot={(value) => {
						snapshot = value;
					}}
				/>,
			);
		});
	}

	it("preserves the known branch and diff summary when checkout is rejected", async () => {
		checkoutMutate.mockResolvedValue({
			ok: false,
			branch: "",
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
			error: "Cannot switch branches while a shared checkout task is active.",
		});
		render();
		const knownVersion = getHomeGitStateVersion();

		await act(async () => {
			await snapshot.checkout("feature/new");
		});

		expect(checkoutMutate).toHaveBeenCalledWith({ branch: "feature/new" });
		expect(snapshot.summary).toEqual(knownSummary);
		expect(snapshot.currentBranch).toBe("feature/current");
		expect(getHomeGitStateVersion()).toBe(knownVersion);
		expect(showAppToast).toHaveBeenCalledWith(expect.objectContaining({ intent: "danger" }));
		expect(onCheckoutSuccess).not.toHaveBeenCalled();
	});

	it.each([
		{ name: "checked-out branch", summary: createSummary("feature/new") },
		{
			name: "detached HEAD",
			summary: { ...createSummary("feature/new"), currentBranch: null, upstreamBranch: null },
		},
	])("applies the measured $name summary when checkout reports a failure", async ({ summary }) => {
		checkoutMutate.mockResolvedValue(createCheckoutResponse(summary, false));
		render();

		await act(async () => {
			await snapshot.checkout("feature/new");
		});

		expect(snapshot.summary).toEqual(summary);
		expect(snapshot.currentBranch).toBe(summary.currentBranch);
		expect(showAppToast).toHaveBeenCalledWith(expect.objectContaining({ intent: "danger" }));
		expect(onCheckoutSuccess).not.toHaveBeenCalled();
	});

	it("applies the home summary after a successful checkout", async () => {
		const nextSummary = createSummary("feature/new");
		checkoutMutate.mockResolvedValue(createCheckoutResponse(nextSummary));
		render();

		await act(async () => {
			await snapshot.checkout("feature/new");
		});

		expect(snapshot.summary).toEqual(nextSummary);
		expect(snapshot.currentBranch).toBe("feature/new");
	});

	it.each([true, false])("ignores a late checkout response after switching projects (ok: %s)", async (ok) => {
		const pending = deferredCheckout();
		checkoutMutate.mockReturnValue(pending.promise);
		render();
		act(() => {
			void snapshot.checkout("feature/new");
		});
		const nextProjectSummary = createSummary("feature/project-b");
		act(() => {
			setProjectMetadataScope("project-b");
			setHomeGitSummary("project-b", nextProjectSummary);
		});
		render("project-b");

		await act(async () => {
			pending.resolve(createCheckoutResponse(createSummary("feature/stale"), ok));
		});

		expect(snapshot.summary).toEqual(nextProjectSummary);
		expect(snapshot.currentBranch).toBe("feature/project-b");
		expect(onCheckoutSuccess).not.toHaveBeenCalled();
		expect(showAppToast).not.toHaveBeenCalled();
	});

	it.each([true, false])(
		"ignores a late checkout response after the same project is relocated (ok: %s)",
		async (ok) => {
			const pending = deferredCheckout();
			checkoutMutate.mockReturnValue(pending.promise);
			render();
			act(() => {
				void snapshot.checkout("feature/new");
			});
			const relocatedSummary = createSummary("feature/relocated");
			act(() => {
				setProjectPath("project-a", "/repo/new-a");
				setHomeGitSummary("project-a", relocatedSummary);
			});

			await act(async () => {
				pending.resolve(createCheckoutResponse(createSummary("feature/stale"), ok));
			});

			expect(snapshot.summary).toEqual(relocatedSummary);
			expect(snapshot.currentBranch).toBe("feature/relocated");
			expect(onCheckoutSuccess).not.toHaveBeenCalled();
			expect(showAppToast).not.toHaveBeenCalled();
		},
	);
});

describe("branch checkout confirmation", () => {
	let root: Root;
	let actions: UseBranchActionsResult;

	beforeEach(() => {
		vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
		root = createRoot(document.createElement("div"));
		resetProjectMetadataStore("project-a");
		setProjectPath("project-a", "/repo/a");
		vi.clearAllMocks();
		checkoutMutate.mockReset();
		stashPushMutate.mockReset();
	});

	afterEach(() => {
		act(() => root.unmount());
		resetProjectMetadataStore();
		vi.unstubAllGlobals();
	});

	function render(scope: "home" | "task", dirty: boolean): void {
		setHomeGitSummary("project-a", { ...createSummary("feature/current"), changedFiles: dirty ? 1 : 0 });
		act(() => {
			root.render(
				<BranchActionsHarness
					projectId="project-a"
					taskScope={scope === "task" ? { taskId: "task-a", baseRef: "main" } : undefined}
					onSnapshot={(snapshot) => {
						actions = snapshot.branchActions;
					}}
				/>,
			);
		});
	}

	it.each([
		{ scope: "home", dirty: false },
		{ scope: "task", dirty: false },
		{ scope: "home", dirty: true },
		{ scope: "task", dirty: true },
	] as const)("waits for confirmation before $scope checkout (dirty: $dirty)", async ({ scope, dirty }) => {
		checkoutMutate.mockResolvedValue(createCheckoutResponse(createSummary("feature/new")));
		render(scope, dirty);

		act(() => actions.handleCheckoutBranch("feature/new"));

		expect(checkoutMutate).not.toHaveBeenCalled();
		expect(actions.checkoutDialogState).toMatchObject({
			type: dirty ? "dirty_warning" : "confirm",
			branch: "feature/new",
			scope,
		});

		await act(async () => {
			const dialog = actions.checkoutDialogState;
			if (dialog.type === "confirm" || dialog.type === "dirty_warning") {
				actions.handleConfirmCheckout(dialog.branch, dialog.scope, dialog.taskId, dialog.baseRef);
			}
		});

		expect(checkoutMutate).toHaveBeenCalledExactlyOnceWith({
			branch: "feature/new",
			...(scope === "task" ? { taskId: "task-a", baseRef: "main" } : {}),
		});
	});

	it.each(["home", "task"] as const)("leaves the current %s branch unchanged", (scope) => {
		render(scope, true);

		act(() => actions.handleCheckoutBranch("feature/current"));

		expect(actions.checkoutDialogState).toEqual({ type: "closed" });
		expect(checkoutMutate).not.toHaveBeenCalled();
		expect(showAppToast).toHaveBeenCalledWith({ message: "Already on feature/current" });
	});

	it.each(["home", "task"] as const)("stashes %s changes before the confirmed checkout", async (scope) => {
		stashPushMutate.mockResolvedValue({ ok: true });
		checkoutMutate.mockResolvedValue(createCheckoutResponse(createSummary("feature/new")));
		render(scope, true);
		act(() => actions.handleCheckoutBranch("feature/new"));

		await act(async () => actions.handleStashAndCheckout());

		expect(stashPushMutate).toHaveBeenCalledExactlyOnceWith({
			taskScope: scope === "task" ? { taskId: "task-a", baseRef: "main" } : null,
			paths: [],
			message: undefined,
		});
		expect(checkoutMutate).toHaveBeenCalledExactlyOnceWith({
			branch: "feature/new",
			...(scope === "task" ? { taskId: "task-a", baseRef: "main" } : {}),
		});
		expect(stashPushMutate.mock.invocationCallOrder[0]!).toBeLessThan(checkoutMutate.mock.invocationCallOrder[0]!);
		expect(actions.checkoutDialogState).toEqual({ type: "closed" });
	});

	it("keeps the dirty checkout warning open when stashing fails", async () => {
		stashPushMutate.mockResolvedValue({ ok: false, error: "Stash failed" });
		render("home", true);
		act(() => actions.handleCheckoutBranch("feature/new"));

		await act(async () => actions.handleStashAndCheckout());

		expect(checkoutMutate).not.toHaveBeenCalled();
		expect(actions.checkoutDialogState).toMatchObject({ type: "dirty_warning", branch: "feature/new" });
	});
});
