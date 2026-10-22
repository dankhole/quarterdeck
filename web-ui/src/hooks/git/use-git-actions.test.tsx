import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useGitActions } from "@/hooks/git/use-git-actions";
import type { RuntimeGitSyncResponse, RuntimeGitSyncSummary } from "@/runtime/types";
import {
	resetProjectMetadataStore,
	setHomeGitSummary,
	setProjectMetadataScope,
	setProjectPath,
	useHomeGitSummaryValue,
} from "@/stores/project-metadata-store";
import type { BoardData } from "@/types";

const runGitSyncActionMutate = vi.hoisted(() => vi.fn<() => Promise<RuntimeGitSyncResponse>>());
const showAppToast = vi.hoisted(() => vi.fn());
const refreshGitHistory = vi.hoisted(() => vi.fn());
const refreshProjectState = vi.hoisted(() => vi.fn(async () => {}));

vi.mock("@/runtime/trpc-client", () => ({
	getRuntimeTrpcClient: () => ({
		project: { runGitSyncAction: { mutate: runGitSyncActionMutate } },
	}),
}));
vi.mock("@/components/app-toaster", () => ({ showAppToast }));
vi.mock("@/components/git/history", () => ({
	useGitHistoryData: () => ({ refresh: refreshGitHistory }),
}));

const board: BoardData = { columns: [] };
const sendTaskSessionInput = vi.fn(async () => ({ ok: true }));
const fetchTaskWorktreeInfo = vi.fn(async () => null);

interface Snapshot {
	runPush: () => Promise<void>;
	summary: RuntimeGitSyncSummary | null;
}

function Harness({ projectId, onSnapshot }: { projectId: string; onSnapshot: (snapshot: Snapshot) => void }): null {
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
	onSnapshot({ runPush: () => actions.runGitAction("push"), summary });
	return null;
}

function freshSummary(): RuntimeGitSyncSummary {
	return {
		currentBranch: "main",
		upstreamBranch: "origin/main",
		changedFiles: 0,
		additions: 0,
		deletions: 0,
		aheadCount: 0,
		behindCount: 0,
	};
}

describe("useGitActions stale summary handling", () => {
	let root: Root;
	let snapshot: Snapshot;
	let previousActEnvironment: boolean | undefined;
	const knownSummary = freshSummary();

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
		runGitSyncActionMutate.mockReset();
		refreshProjectState.mockReset().mockResolvedValue(undefined);
	});

	afterEach(() => {
		act(() => root.unmount());
		resetProjectMetadataStore();
		(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
			previousActEnvironment;
	});

	function render(projectId: string): void {
		act(() => {
			root.render(<Harness projectId={projectId} onSnapshot={(value) => (snapshot = value)} />);
		});
	}

	it("skips applying a stale summary and requests a metadata refresh instead", async () => {
		runGitSyncActionMutate.mockResolvedValue({
			ok: true,
			action: "push",
			output: "",
			summary: { ...freshSummary(), currentBranch: null, aheadCount: 0, stale: true },
		});
		render("project-a");

		await act(async () => {
			await snapshot.runPush();
		});

		// The store keeps the last known-good summary; the degraded (null branch)
		// one from the stale response was never applied.
		expect(snapshot.summary).toEqual(knownSummary);
		expect(refreshProjectState).toHaveBeenCalledWith({ suppressErrorToast: true });
	});

	it("applies a fresh (non-stale) summary normally, without requesting a refresh", async () => {
		const updated = { ...freshSummary(), aheadCount: 2 };
		runGitSyncActionMutate.mockResolvedValue({
			ok: true,
			action: "push",
			output: "",
			summary: updated,
		});
		render("project-a");

		await act(async () => {
			await snapshot.runPush();
		});

		expect(snapshot.summary).toEqual(updated);
		expect(refreshProjectState).not.toHaveBeenCalled();
	});
});
