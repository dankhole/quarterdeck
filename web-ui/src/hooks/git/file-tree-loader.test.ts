// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import type { RuntimeListFilesResponse } from "@/runtime/types";
import { fileTreePage } from "@/test-utils/file-tree";
import { FileTreeLoader } from "./file-tree-loader";

function deferred() {
	let resolve!: (page: RuntimeListFilesResponse) => void;
	const promise = new Promise<RuntimeListFilesResponse>((done) => {
		resolve = done;
	});
	return { promise, resolve };
}

describe("FileTreeLoader", () => {
	it("bounds fanout, deduplicates requests, and skips queued collapsed directories", async () => {
		const first = deferred();
		const second = deferred();
		const fetch = vi.fn().mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
		const loader = new FileTreeLoader(fetch, vi.fn());
		loader.start();
		loader.visible = new Set(["", "a", "b"]);
		const root = loader.load("");
		expect(loader.load("")).toBe(root);
		const a = loader.load("a");
		const b = loader.load("b");
		expect(fetch).toHaveBeenCalledTimes(2);
		loader.visible.delete("b");
		first.resolve(fileTreePage());
		second.resolve(fileTreePage({ directory: "a" }));
		await Promise.all([root, a, b]);
		expect(fetch).toHaveBeenCalledTimes(2);
		loader.stop();
	});
	it("retains successful pages and errors while retrying then appends an empty continuation", async () => {
		const retry = deferred();
		const fetch = vi
			.fn()
			.mockResolvedValueOnce(fileTreePage({ files: ["one"], nextCursor: "cursor" }))
			.mockRejectedValueOnce(new Error("offline"))
			.mockReturnValueOnce(retry.promise);
		const loader = new FileTreeLoader(fetch, vi.fn());
		loader.start();
		await loader.load("");
		await loader.load("", true);
		expect(loader.pages[""]?.data?.files).toEqual(["one"]);
		const loading = loader.load("", true);
		expect(loader.pages[""]).toMatchObject({ loading: true, error: new Error("offline") });
		retry.resolve(fileTreePage({ nextCursor: "another" }));
		await loading;
		expect(fetch).toHaveBeenLastCalledWith("", "cursor");
		expect(loader.pages[""]).toMatchObject({ error: null, data: { files: ["one"], nextCursor: "another" } });
		loader.stop();
	});
	it("fences stopped generations and waits for pending work before mutation refresh", async () => {
		const stale = deferred();
		const fetch = vi
			.fn()
			.mockReturnValueOnce(stale.promise)
			.mockResolvedValue(fileTreePage({ files: ["new"], snapshotId: "new" }));
		const loader = new FileTreeLoader(fetch, vi.fn());
		loader.start();
		const loading = loader.load("");
		const refreshed = loader.refresh("");
		stale.resolve(fileTreePage({ files: ["old"] }));
		await loading;
		await refreshed;
		expect(loader.pages[""]?.data?.files).toEqual(["new"]);
		const late = deferred();
		fetch.mockReturnValueOnce(late.promise);
		const stopped = loader.load("");
		loader.stop();
		late.resolve(fileTreePage({ files: ["late"] }));
		await stopped;
		expect(loader.pages[""]?.data?.files).toEqual(["new"]);
	});
	it("stages bounded depth restoration including empty pages and continuation deduplication", async () => {
		const last = deferred();
		const fetch = vi
			.fn()
			.mockResolvedValueOnce(fileTreePage({ files: ["old"], nextCursor: "old2" }))
			.mockResolvedValueOnce(fileTreePage({ nextCursor: "old3" }))
			.mockResolvedValueOnce(fileTreePage({ files: ["old", "later"], nextCursor: "old4" }));
		const loader = new FileTreeLoader(fetch, vi.fn());
		loader.start();
		await loader.load("");
		await loader.load("", true);
		await loader.load("", true);
		fetch
			.mockResolvedValueOnce(fileTreePage({ snapshotId: "new", files: ["fresh"], nextCursor: "new2" }))
			.mockResolvedValueOnce(fileTreePage({ snapshotId: "new", nextCursor: "new3" }))
			.mockReturnValueOnce(last.promise);
		const refresh = loader.refresh("");
		await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(6));
		expect(loader.pages[""]?.data?.files).toEqual(["old", "later"]);
		last.resolve(fileTreePage({ snapshotId: "new", files: ["fresh", "restored"], nextCursor: "new4" }));
		await refresh;
		expect(loader.pages[""]?.data).toMatchObject({ files: ["fresh", "restored"], nextCursor: "new4" });
		expect(fetch).toHaveBeenCalledTimes(6);
		loader.stop();
	});

	it("retains old pages and depth after a failed replacement, then retries successfully", async () => {
		const fetch = vi
			.fn()
			.mockResolvedValueOnce(fileTreePage({ files: ["old"], nextCursor: "old2" }))
			.mockResolvedValueOnce(fileTreePage({ files: ["later"], nextCursor: "old3" }));
		const loader = new FileTreeLoader(fetch, vi.fn());
		loader.start();
		await loader.load("");
		await loader.load("", true);
		fetch
			.mockResolvedValueOnce(fileTreePage({ snapshotId: "new", files: ["fresh"], nextCursor: "new2" }))
			.mockRejectedValueOnce(new Error("offline"));
		await loader.refresh("");
		expect(loader.pages[""]).toMatchObject({
			data: { files: ["old", "later"], nextCursor: "old3" },
			error: new Error("offline"),
		});
		fetch
			.mockResolvedValueOnce(fileTreePage({ snapshotId: "new", files: ["fresh"], nextCursor: "new2" }))
			.mockResolvedValueOnce(fileTreePage({ snapshotId: "new", files: ["restored"] }));
		await loader.refresh("");
		expect(loader.pages[""]).toMatchObject({ data: { files: ["fresh", "restored"], nextCursor: null }, error: null });
		loader.stop();
	});

	it("restores expired append cursors but bounds repeated snapshot restarts", async () => {
		const fetch = vi
			.fn()
			.mockResolvedValueOnce(fileTreePage({ files: ["old"], nextCursor: "old2" }))
			.mockResolvedValueOnce(fileTreePage({ files: ["later"], nextCursor: "old3" }));
		const loader = new FileTreeLoader(fetch, vi.fn());
		loader.start();
		await loader.load("");
		await loader.load("", true);
		fetch
			.mockResolvedValueOnce(fileTreePage({ snapshotId: "new", nextCursor: "new2" }))
			.mockResolvedValueOnce(fileTreePage({ snapshotId: "new", files: ["a"], nextCursor: "new3" }))
			.mockResolvedValueOnce(fileTreePage({ snapshotId: "new", files: ["b"], nextCursor: "new4" }));
		await loader.load("", true);
		expect(loader.pages[""]?.data).toMatchObject({ files: ["a", "b"], nextCursor: "new4" });
		const before = fetch.mock.calls.length;
		let generation = 0;
		fetch.mockImplementation(async () => fileTreePage({ snapshotId: `reset-${++generation}`, nextCursor: "reset" }));
		await loader.refresh("");
		expect(fetch.mock.calls.length - before).toBe(3);
		expect(loader.pages[""]?.data?.files).toEqual(["a", "b"]);
		expect(loader.pages[""]?.error?.message).toContain("changed repeatedly");
		loader.stop();
	});
	it("fences a stopped restoration before its staged replacement is published", async () => {
		const staged = deferred();
		const fetch = vi
			.fn()
			.mockResolvedValueOnce(fileTreePage({ files: ["old"], nextCursor: "old2" }))
			.mockResolvedValueOnce(fileTreePage({ files: ["later"], nextCursor: "old3" }));
		const loader = new FileTreeLoader(fetch, vi.fn());
		loader.start();
		await loader.load("");
		await loader.load("", true);
		fetch
			.mockResolvedValueOnce(fileTreePage({ snapshotId: "new", nextCursor: "new2" }))
			.mockReturnValueOnce(staged.promise);
		const refresh = loader.refresh("");
		await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(4));
		loader.stop();
		staged.resolve(fileTreePage({ snapshotId: "new", files: ["stale"] }));
		await refresh;
		expect(loader.pages[""]?.data?.files).toEqual(["old", "later"]);
		expect(loader.pages[""]?.loading).toBe(false);
	});
});
