import { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RuntimeFileContentResponse, RuntimeProjectMetadata } from "@/runtime/types";
import { resolveFileBrowserScope } from "./file-browser-scope";
import {
	clearCachedFileEditorTabs,
	discardFileEditorDraft,
	getCachedFileEditorTabs,
	getFileEditorDrafts,
	guardFileEditorScopes,
	reconcileFileEditorWorktrees,
	registerFileEditorScope,
	setCachedFileEditorTabs,
	setFileEditorReviewTarget,
} from "./file-editor-cache";
import { createFileEditorTab } from "./file-editor-workspace";
import { type UseFileContentDataResult, useFileContentData } from "./use-file-content-data";
import { type UseFileEditorWorkspaceResult, useFileEditorWorkspace } from "./use-file-editor-workspace";

const query = vi.hoisted(() => vi.fn());
const mutate = vi.hoisted(() => vi.fn());
vi.mock("@/runtime/trpc-client", () => ({
	getRuntimeTrpcClient: () => ({ project: { getFileContent: { query }, saveFileContent: { mutate } } }),
}));
vi.mock("@/components/app-toaster", () => ({ showAppToast: vi.fn() }));

const identity = { projectId: "project", taskId: "task", taskCreatedAt: 1, rootPath: "/synthetic/task" };
const scope = resolveFileBrowserScope(identity);

function contentResponse(content: string, contentHash: string): RuntimeFileContentResponse {
	return { content, contentHash, language: "typescript", binary: false, size: content.length, truncated: false };
}

function deferredContent() {
	let resolve: (content: RuntimeFileContentResponse) => void = () => {};
	const promise = new Promise<RuntimeFileContentResponse>((finish) => {
		resolve = finish;
	});
	return { promise, resolve };
}

function worktreeMetadata(exists: boolean): RuntimeProjectMetadata {
	return {
		homeGitSummary: null,
		homeGitStateVersion: 0,
		homeStashCount: 0,
		taskWorktrees: [
			{
				taskId: identity.taskId,
				path: identity.rootPath,
				exists,
				baseRef: "main",
				branch: null,
				isDetached: false,
				headCommit: null,
				changedFiles: null,
				additions: null,
				deletions: null,
				hasUnmergedChanges: null,
				behindBaseCount: null,
				behindRemoteBaseCount: null,
				stateVersion: 1,
			},
		],
	};
}

interface Snapshot {
	workspace: UseFileEditorWorkspaceResult;
	content: UseFileContentDataResult;
	selectPath: (path: string) => void;
}

function Harness({ onSnapshot }: { onSnapshot: (snapshot: Snapshot) => void }) {
	const [selectedPath, setSelectedPath] = useState<string | null>("file.ts");
	const content = useFileContentData(scope, selectedPath);
	const workspace = useFileEditorWorkspace({
		scopeKey: scope.contentScopeKey,
		scope: identity,
		selectedPath,
		fileContent: content.fileContent,
		isContentLoading: content.isContentLoading,
		isContentError: content.isContentError,
		isReadOnly: false,
		autosaveMode: "off",
		onSelectPath: setSelectedPath,
		onCloseFile: () => setSelectedPath(null),
		reloadFileContent: content.reloadFileContent,
		saveFileContent: content.saveFileContent,
	});
	onSnapshot({ workspace, content, selectPath: setSelectedPath });
	return null;
}

describe("file content and editor scope lifecycle", () => {
	let root: Root;
	let latest: Snapshot;
	let previousActEnvironment: boolean | undefined;

	beforeEach(() => {
		previousActEnvironment = (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean })
			.IS_REACT_ACT_ENVIRONMENT;
		(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
		clearCachedFileEditorTabs();
		query.mockReset().mockResolvedValue(contentResponse("original disk", "original-hash"));
		mutate.mockReset();
		root = createRoot(document.createElement("div"));
	});

	afterEach(async () => {
		await act(async () => root.unmount());
		clearCachedFileEditorTabs();
		(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
			previousActEnvironment;
	});

	async function render() {
		await act(async () =>
			root.render(
				<Harness
					onSnapshot={(snapshot) => {
						latest = snapshot;
					}}
				/>,
			),
		);
	}

	it.each(["save", "reload"] as const)(
		"fences a late %s response from the retired scope through both hooks",
		async (requestKind) => {
			await render();
			const oldReply = deferredContent();
			let pending: Promise<unknown> = Promise.resolve();
			await act(async () => {
				if (requestKind === "save") {
					latest.workspace.handleChangeActiveContent("retired draft");
				}
			});
			await act(async () => {
				if (requestKind === "save") {
					mutate.mockReturnValueOnce(oldReply.promise);
					pending = latest.workspace.handleSaveActiveTab();
				} else {
					query.mockReturnValueOnce(oldReply.promise);
					pending = latest.content.reloadFileContent("file.ts");
				}
			});
			// The old write/read completed against the former worktree; only its RPC reply is delayed.
			query.mockRejectedValue(new Error("Worktree missing"));
			await act(async () => reconcileFileEditorWorktrees(identity.projectId, worktreeMetadata(false)));
			expect(latest.workspace.tabs).toEqual([]);
			const restoredRead = deferredContent();
			query.mockReturnValue(restoredRead.promise);
			await act(async () => reconcileFileEditorWorktrees(identity.projectId, worktreeMetadata(true)));
			// Cached content from before retirement must not seed the new generation while its read is pending.
			expect(latest.content.fileContent).toBeNull();
			expect(latest.workspace.activeTab).toBeNull();
			await act(async () => restoredRead.resolve(contentResponse("restored disk", "restored-hash")));
			expect(latest.workspace.activeTab).toMatchObject({
				value: "restored disk",
				savedValue: "restored disk",
				contentHash: "restored-hash",
			});
			await act(async () => {
				oldReply.resolve(contentResponse("retired draft", "old-response-hash"));
				await pending;
			});
			expect(latest.content.fileContent).toMatchObject({ content: "restored disk", contentHash: "restored-hash" });
			expect(latest.workspace.activeTab).toMatchObject({
				value: "restored disk",
				savedValue: "restored disk",
				contentHash: "restored-hash",
			});
			if (requestKind === "save") expect(getFileEditorDrafts("detached")[0]?.tab.value).toBe("retired draft");
			await act(async () => latest.workspace.handleChangeActiveContent("new draft"));
			expect(latest.workspace.activeTab?.value).toBe("new draft");
		},
	);

	it("keeps the selected file usable after attached discard without discarding another buffer", async () => {
		await render();
		registerFileEditorScope("other", { projectId: "other-project", taskId: null });
		setCachedFileEditorTabs("other", [
			{ ...createFileEditorTab("other.ts", contentResponse("other disk", "other-hash")), value: "other draft" },
		]);
		await act(async () => latest.workspace.handleChangeActiveContent("discard me"));
		await act(async () => expect(guardFileEditorScopes({ projectId: identity.projectId })).toBe(false));
		await act(async () => {
			discardFileEditorDraft(getFileEditorDrafts()[0]!);
			setFileEditorReviewTarget(null);
		});
		expect(latest.workspace.activePath).toBe("file.ts");
		expect(latest.workspace.activeTab).toMatchObject({
			value: "original disk",
			savedValue: "original disk",
			contentHash: "original-hash",
		});
		expect(guardFileEditorScopes({ projectId: identity.projectId })).toBe(true);
		await act(async () => latest.selectPath("file.ts"));
		expect(latest.workspace.activeTab?.value).toBe("original disk");
		expect(getCachedFileEditorTabs("other")[0]?.value).toBe("other draft");
		await act(async () => latest.workspace.handleChangeActiveContent("new edit"));
		expect(latest.workspace.activeTab?.value).toBe("new edit");
	});
});
