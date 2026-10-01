import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useBranchActions } from "@/hooks/git/use-branch-actions";
import { useGitActions } from "@/hooks/git/use-git-actions";
import type { RuntimeGitCheckoutResponse, RuntimeGitSyncSummary } from "@/runtime/types";
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
const showAppToast = vi.hoisted(() => vi.fn());
const refreshGitHistory = vi.hoisted(() => vi.fn());

vi.mock("@/runtime/trpc-client", () => ({
	getRuntimeTrpcClient: () => ({
		project: { checkoutGitBranch: { mutate: checkoutMutate } },
	}),
}));

vi.mock("@/components/app-toaster", () => ({ showAppToast }));
vi.mock("@/components/git/history", () => ({
	useGitHistoryData: () => ({ refresh: refreshGitHistory }),
}));

const board: BoardData = { columns: [] };
const selectBranchView = vi.fn();
const sendTaskSessionInput = vi.fn(async () => ({ ok: true }));
const fetchTaskWorktreeInfo = vi.fn(async () => null);
const onCheckoutSuccess = vi.fn();
const refreshProjectState = vi.fn(async () => {});

interface CheckoutSnapshot {
	checkout: (branch: string) => Promise<void> | void;
	summary: RuntimeGitSyncSummary | null;
	currentBranch: string | null;
}

interface HarnessProps {
	projectId: string;
	onSnapshot: (snapshot: CheckoutSnapshot) => void;
}

function BranchActionsHarness({ projectId, onSnapshot }: HarnessProps): null {
	const summary = useHomeGitSummaryValue();
	const actions = useBranchActions({
		projectId,
		board,
		selectBranchView,
		homeGitSummary: summary,
		onCheckoutSuccess,
	});
	onSnapshot({
		checkout: (branch) => actions.handleConfirmCheckout(branch, "home"),
		summary,
		currentBranch: actions.currentBranch,
	});
	return null;
}

function GitActionsHarness({ projectId, onSnapshot }: HarnessProps): null {
	const summary = useHomeGitSummaryValue();
	const actions = useGitActions({
		currentProjectId: projectId,
		board,
		selectedCard: null,
		runtimeProjectConfig: null,
		sendTaskSessionInput,
		fetchTaskWorktreeInfo,
		isGitHistoryOpen: false,
		refreshProjectState,
	});
	onSnapshot({ checkout: actions.switchHomeBranch, summary, currentBranch: summary?.currentBranch ?? null });
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

describe.each([
	{ name: "branch selector", Harness: BranchActionsHarness },
	{ name: "home view", Harness: GitActionsHarness },
])("$name checkout", ({ Harness }) => {
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
				<Harness
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
		expect(refreshProjectState).not.toHaveBeenCalled();
		expect(refreshGitHistory).not.toHaveBeenCalled();
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
		expect(refreshProjectState).not.toHaveBeenCalled();
		expect(refreshGitHistory).not.toHaveBeenCalled();
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
		expect(refreshProjectState).not.toHaveBeenCalled();
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
			expect(refreshProjectState).not.toHaveBeenCalled();
			expect(showAppToast).not.toHaveBeenCalled();
		},
	);
});
