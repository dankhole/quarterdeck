import { act, useMemo } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RuntimeListFilesRequest, RuntimeListFilesResponse } from "@/runtime/types";
import { fileTreePage } from "@/test-utils/file-tree";
import { resolveFileBrowserScope } from "./file-browser-scope";
import { type UseFileTreeDataResult, useFileTreeData } from "./use-file-tree-data";

const query = vi.hoisted(() => vi.fn());
vi.mock("@/runtime/trpc-client", () => ({ getRuntimeTrpcClient: () => ({ project: { listFiles: { query } } }) }));

let latest: UseFileTreeDataResult;
function Harness({
	taskId = null,
	browseRef = null,
	enabled = true,
}: {
	taskId?: string | null;
	browseRef?: string | null;
	enabled?: boolean;
}) {
	const scope = useMemo(
		() => resolveFileBrowserScope({ projectId: "project", taskId, ref: browseRef, enabled }),
		[taskId, browseRef, enabled],
	);
	latest = useFileTreeData(scope);
	return null;
}

describe("useFileTreeData", () => {
	let root: Root;
	let container: HTMLDivElement;
	beforeEach(() => {
		vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
		vi.useFakeTimers();
		container = document.createElement("div");
		root = createRoot(container);
		query.mockReset();
		query.mockImplementation(async ({ directory }: RuntimeListFilesRequest) =>
			directory
				? fileTreePage({ directory, directories: [`${directory}/nested`], files: [`${directory}/one`] })
				: fileTreePage({ directories: ["src", "unopened"], nextCursor: "root-more" }),
		);
	});
	afterEach(async () => {
		await act(async () => root.unmount());
		vi.useRealTimers();
		vi.unstubAllGlobals();
	});
	it("loads only root then requested expansion, polls visible directories, and stops while inactive", async () => {
		await act(async () => root.render(<Harness />));
		expect(query.mock.calls.map(([request]) => request.directory)).toEqual([""]);
		await act(async () => latest.setExpandedDirectories(new Set(["src"])));
		expect(query.mock.calls.map(([request]) => request.directory)).toEqual(["", "src"]);
		expect(latest.files).toEqual(["src/one"]);
		await act(async () => latest.setExpandedDirectories(new Set(["src/nested"])));
		query.mockClear();
		await act(async () => vi.advanceTimersByTimeAsync(5_000));
		expect(query.mock.calls.map(([request]) => request.directory)).toEqual([""]);
		await act(async () => root.render(<Harness enabled={false} />));
		query.mockClear();
		await act(async () => vi.advanceTimersByTimeAsync(15_000));
		expect(query).not.toHaveBeenCalled();
	});
	it("retains load-more pages during polling and resets them on a new snapshot", async () => {
		await act(async () => root.render(<Harness />));
		query.mockResolvedValueOnce(fileTreePage({ files: ["later"], nextCursor: "last" }));
		await act(async () => {
			await latest.loadDirectory("", true);
		});
		expect(latest.files).toContain("later");
		await act(async () => vi.advanceTimersByTimeAsync(5_000));
		expect(latest.files).toContain("later");
		expect(latest.directoryPages[""]?.data?.nextCursor).toBe("last");
		query.mockResolvedValueOnce(fileTreePage({ snapshotId: "reset", files: ["fresh"] }));
		await act(async () => vi.advanceTimersByTimeAsync(5_000));
		expect(latest.files).toEqual(["fresh"]);
	});
	it.each(["toggle", "task", "ref"])("ignores late %s-scope responses", async (change) => {
		let resolveOld!: (page: RuntimeListFilesResponse) => void;
		query.mockImplementationOnce(
			() =>
				new Promise<RuntimeListFilesResponse>((resolve) => {
					resolveOld = resolve;
				}),
		);
		await act(async () => root.render(<Harness />));
		await act(async () => {
			if (change === "toggle") latest.setShowExcluded(true);
			else
				root.render(
					<Harness taskId={change === "task" ? "task" : null} browseRef={change === "ref" ? "main" : null} />,
				);
		});
		await act(async () => resolveOld(fileTreePage({ files: ["stale"] })));
		expect(latest.files).not.toContain("stale");
		expect(query.mock.lastCall?.[0]).toMatchObject(
			change === "toggle" ? { showExcluded: true } : change === "task" ? { taskId: "task" } : { ref: "main" },
		);
	});
	it("does not overlap slow polling rounds and does not poll read-only refs", async () => {
		await act(async () => root.render(<Harness />));
		let resolveSlow!: (page: RuntimeListFilesResponse) => void;
		query.mockImplementationOnce(
			() =>
				new Promise<RuntimeListFilesResponse>((resolve) => {
					resolveSlow = resolve;
				}),
		);
		await act(async () => vi.advanceTimersByTimeAsync(25_000));
		expect(query).toHaveBeenCalledTimes(2);
		await act(async () => resolveSlow(fileTreePage({ directories: ["src"] })));
		await act(async () => vi.advanceTimersByTimeAsync(5_000));
		expect(query).toHaveBeenCalledTimes(3);
		await act(async () => root.render(<Harness browseRef="main" />));
		query.mockClear();
		await act(async () => vi.advanceTimersByTimeAsync(20_000));
		expect(query).not.toHaveBeenCalled();
	});
	it("restores loaded depth atomically when a poll expires after 35 seconds", async () => {
		await act(async () => root.render(<Harness />));
		query.mockResolvedValueOnce(fileTreePage({ files: ["page-two"], nextCursor: "old3" }));
		await act(async () => {
			await latest.loadDirectory("", true);
		});
		await act(async () => vi.advanceTimersByTimeAsync(30_000));
		let finish!: (page: RuntimeListFilesResponse) => void;
		query
			.mockResolvedValueOnce(fileTreePage({ snapshotId: "expired", files: ["fresh"], nextCursor: "fresh2" }))
			.mockImplementationOnce(
				() =>
					new Promise<RuntimeListFilesResponse>((resolve) => {
						finish = resolve;
					}),
			);
		await act(async () => vi.advanceTimersByTimeAsync(5_000));
		expect(latest.files).toContain("page-two");
		expect(query.mock.lastCall?.[0].cursor).toBe("fresh2");
		await act(async () => finish(fileTreePage({ snapshotId: "expired", files: ["page-two"], nextCursor: "fresh3" })));
		expect(latest.files).toEqual(["fresh", "page-two"]);
		expect(latest.directoryPages[""]?.data?.nextCursor).toBe("fresh3");
	});
	it("expires absent receipt insertions on complete parent proof without resurrecting them on later partial pages", async () => {
		await act(async () => root.render(<Harness />));
		await act(async () => latest.revealEntry("receipt.txt", "file"));
		query.mockResolvedValueOnce(fileTreePage({ snapshotId: "partial", nextCursor: "more" }));
		await act(async () => vi.advanceTimersByTimeAsync(5_000));
		expect(latest.files).toContain("receipt.txt");
		query.mockResolvedValueOnce(fileTreePage({ snapshotId: "complete" }));
		await act(async () => vi.advanceTimersByTimeAsync(5_000));
		expect(latest.files).not.toContain("receipt.txt");
		query.mockResolvedValueOnce(fileTreePage({ snapshotId: "partial-again", nextCursor: "more" }));
		await act(async () => vi.advanceTimersByTimeAsync(5_000));
		expect(latest.files).not.toContain("receipt.txt");
	});
});
