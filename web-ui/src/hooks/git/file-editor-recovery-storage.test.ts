// @vitest-environment node

import { afterEach, describe, expect, it, vi } from "vitest";
import {
	canRestoreFileEditorDraft,
	clearCachedFileEditorTabs,
	discardFileEditorDraft,
	getCachedFileEditorTabs,
	getFileEditorDrafts,
	getFileEditorRecoveryStatus,
	getFileEditorReviewTarget,
	registerFileEditorScope,
	restoreFileEditorDraft,
	setCachedFileEditorTabs,
	setFileEditorRecoveryStatus,
	setFileEditorReviewTarget,
} from "./file-editor-cache";
import {
	decodeFileEditorRecovery,
	encodeFileEditorRecovery,
	FILE_EDITOR_RECOVERY_KEY,
	FILE_EDITOR_RECOVERY_LIMITS,
} from "./file-editor-recovery";
import {
	connectFileEditorRecoveryStorage,
	type FileEditorRecoveryStorage,
	flushFileEditorRecoveryStorage,
	getFileEditorRecoveryCommitStatus,
	resetFileEditorRecoveryStorage,
	retryFileEditorRecoveryStorage,
} from "./file-editor-recovery-storage";
import { createFileEditorTab } from "./file-editor-workspace";

const scope = { projectId: "p", taskId: "t", taskCreatedAt: 1, rootPath: "/repo/worktree" };
const tab = {
	...createFileEditorTab("a.ts", {
		content: "saved",
		contentHash: "original-hash",
		language: "typescript",
		binary: false,
		truncated: false,
		size: 5,
	}),
	value: "recovered text",
};
const disposers: (() => void)[] = [];
afterEach(() => {
	for (const dispose of disposers.splice(0)) dispose();
	clearCachedFileEditorTabs();
	setFileEditorRecoveryStatus(null, 0);
});
async function settle() {
	for (let i = 0; i < 12; i++) await Promise.resolve();
}
function deferred<T>() {
	let resolve!: (value: T) => void;
	let reject!: (error: Error) => void;
	const promise = new Promise<T>((accept, fail) => {
		resolve = accept;
		reject = fail;
	});
	return { promise, resolve, reject };
}
function encodedDraft(value = tab.value) {
	const result = encodeFileEditorRecovery(
		[
			{
				id: "record",
				recoveryId: "record",
				scopeKey: "p:t",
				generation: 1,
				scope,
				detached: false,
				tab: { ...tab, value },
			},
		],
		[],
		100,
	);
	if (!result.ok) throw new Error("Invalid fixture");
	return result.raw;
}
function memoryStorage(initial?: string) {
	const state = { raw: initial, refuse: false, refuseRead: false };
	const storage = {
		read: vi.fn(async () => {
			if (state.refuseRead) throw new Error("read unavailable");
			return state.raw;
		}),
		write: vi.fn(async (raw: string) => {
			if (state.refuse) throw new Error("commit aborted");
			state.raw = raw;
		}),
	};
	return { state, storage };
}
function connect(storage: FileEditorRecoveryStorage, legacy?: Storage) {
	disposers.push(connectFileEditorRecoveryStorage(storage, () => 100, legacy));
}
function writeDraft(value = tab.value) {
	registerFileEditorScope("p:t", scope);
	setCachedFileEditorTabs("p:t", [{ ...tab, value }]);
}
async function flush(storage: FileEditorRecoveryStorage) {
	const result = await flushFileEditorRecoveryStorage(storage);
	await settle();
	return result;
}

describe("strict desktop recovery commit controller", () => {
	it("subscribes before async hydration and merges recovered text with newer live edits before its first write", async () => {
		const reading = deferred<string | undefined>();
		const memory = memoryStorage();
		memory.storage.read.mockReturnValue(reading.promise);
		connect(memory.storage);
		writeDraft("new current text");
		await settle();
		expect(memory.storage.write).not.toHaveBeenCalled();
		expect(getFileEditorRecoveryCommitStatus(memory.storage)).toMatchObject({ loaded: false, ready: false });
		reading.resolve(encodedDraft());
		expect(await flush(memory.storage)).toBe(true);
		expect(getFileEditorDrafts("detached")[0]?.tab.value).toBe(tab.value);
		expect(getCachedFileEditorTabs("p:t")[0]?.value).toBe("new current text");
		expect(decodeFileEditorRecovery(memory.state.raw!, 100).drafts.map((draft) => draft.tab.value)).toEqual([
			tab.value,
			"new current text",
		]);
		expect(canRestoreFileEditorDraft(getFileEditorDrafts("detached")[0]!)).toBe(false);
	});

	it("keeps one write in flight, queues the latest snapshot and lets a captured flush finish before newer typing", async () => {
		const memory = memoryStorage();
		connect(memory.storage);
		expect(await flush(memory.storage)).toBe(true);
		const writes: { raw: string; completion: ReturnType<typeof deferred<void>> }[] = [];
		memory.storage.write.mockImplementation(async (raw) => {
			const completion = deferred<void>();
			writes.push({ raw, completion });
			await completion.promise;
			memory.state.raw = raw;
		});
		writeDraft("one");
		const firstFlush = flushFileEditorRecoveryStorage(memory.storage);
		writeDraft("two");
		writeDraft("three");
		await settle();
		expect(writes).toHaveLength(1);
		expect(getFileEditorRecoveryCommitStatus(memory.storage).ready).toBe(false);
		writes[0]!.completion.resolve();
		expect(await firstFlush).toBe(true);
		await settle();
		expect(writes).toHaveLength(2);
		expect(decodeFileEditorRecovery(writes[1]!.raw, 100).drafts[0]?.tab.value).toBe("three");
		expect(getFileEditorRecoveryCommitStatus(memory.storage).ready).toBe(false);
		writes[1]!.completion.resolve();
		expect(await flush(memory.storage)).toBe(true);
		expect(getFileEditorRecoveryCommitStatus(memory.storage).ready).toBe(true);
	});

	it("does not turn status/review changes into writes or timestamp feedback", async () => {
		let now = 100;
		const memory = memoryStorage();
		disposers.push(connectFileEditorRecoveryStorage(memory.storage, () => now));
		writeDraft();
		expect(await flush(memory.storage)).toBe(true);
		const writes = memory.storage.write.mock.calls.length;
		const raw = memory.state.raw;
		now = 500;
		setFileEditorReviewTarget("all");
		setFileEditorReviewTarget(null);
		setFileEditorRecoveryStatus("storage");
		expect(await flush(memory.storage)).toBe(true);
		expect(memory.storage.write).toHaveBeenCalledTimes(writes);
		expect(memory.state.raw).toBe(raw);
	});

	it("retains prior acknowledged bytes and current text after an aborted write; Retry does not reread or drop edits", async () => {
		const memory = memoryStorage();
		connect(memory.storage);
		writeDraft();
		expect(await flush(memory.storage)).toBe(true);
		const retained = memory.state.raw;
		memory.state.refuse = true;
		writeDraft("latest");
		expect(await flush(memory.storage)).toBe(false);
		expect(memory.state.raw).toBe(retained);
		expect(getCachedFileEditorTabs("p:t")[0]?.value).toBe("latest");
		expect(getFileEditorRecoveryCommitStatus(memory.storage)).toMatchObject({
			loaded: true,
			ready: false,
			problem: "storage",
			busy: false,
		});
		const writes = memory.storage.write.mock.calls.length;
		setFileEditorReviewTarget("all");
		await settle();
		expect(memory.storage.write).toHaveBeenCalledTimes(writes);
		memory.state.refuse = false;
		expect(await retryFileEditorRecoveryStorage(memory.storage)).toBe(true);
		await settle();
		expect(memory.storage.read).toHaveBeenCalledOnce();
		expect(decodeFileEditorRecovery(memory.state.raw!, 100).drafts[0]?.tab.value).toBe("latest");
	});

	it("quarantines a failed read until explicit Retry hydrates the old snapshot before any new write", async () => {
		const memory = memoryStorage(encodedDraft());
		memory.state.refuseRead = true;
		connect(memory.storage);
		writeDraft("new current draft");
		expect(await flush(memory.storage)).toBe(false);
		expect(getFileEditorRecoveryStatus()).toMatchObject({ problem: "storage", paused: true });
		expect(memory.storage.write).not.toHaveBeenCalled();
		expect(await retryFileEditorRecoveryStorage(memory.storage)).toBe(false);
		memory.state.refuseRead = false;
		expect(await retryFileEditorRecoveryStorage(memory.storage)).toBe(true);
		await settle();
		expect(decodeFileEditorRecovery(memory.state.raw!, 100).drafts.map((draft) => draft.tab.value)).toEqual([
			tab.value,
			"new current draft",
		]);
	});

	it("quarantines malformed/oversized saved data and cannot erase it when confirmed reset exceeds quotas or aborts", async () => {
		const memory = memoryStorage("{invalid");
		connect(memory.storage);
		writeDraft("x".repeat(FILE_EDITOR_RECOVERY_LIMITS.maxDraftBytes));
		expect(await flush(memory.storage)).toBe(false);
		expect(await resetFileEditorRecoveryStorage(memory.storage)).toBe(false);
		expect(memory.state.raw).toBe("{invalid");
		expect(memory.storage.write).not.toHaveBeenCalled();
		writeDraft();
		memory.state.refuse = true;
		expect(await resetFileEditorRecoveryStorage(memory.storage)).toBe(false);
		await settle();
		expect(memory.state.raw).toBe("{invalid");
		expect(getFileEditorRecoveryStatus().paused).toBe(true);
		memory.state.refuse = false;
		expect(await resetFileEditorRecoveryStorage(memory.storage)).toBe(true);
		expect(decodeFileEditorRecovery(memory.state.raw!, 100).drafts[0]?.tab.value).toBe(tab.value);
	});

	it("joins a pending initial-quarantine reset from flush and remount without rehydrating old storage", async () => {
		const memory = memoryStorage("{invalid");
		connect(memory.storage);
		writeDraft("first");
		expect(await flush(memory.storage)).toBe(false);
		const writes: { raw: string; completion: ReturnType<typeof deferred<void>> }[] = [];
		memory.storage.write.mockImplementation(async (raw) => {
			const completion = deferred<void>();
			writes.push({ raw, completion });
			await completion.promise;
			memory.state.raw = raw;
		});
		const reset = resetFileEditorRecoveryStorage(memory.storage);
		await settle();
		expect(writes).toHaveLength(1);
		writeDraft("newer during reset");
		const flushing = flushFileEditorRecoveryStorage(memory.storage);
		connect(memory.storage);
		await settle();
		expect(memory.storage.read).toHaveBeenCalledOnce();
		expect(getFileEditorDrafts("detached")).toEqual([]);
		writes[0]!.completion.resolve();
		expect(await reset).toBe(true);
		await settle();
		expect(writes).toHaveLength(2);
		writes[1]!.completion.resolve();
		expect(await flushing).toBe(true);
		await settle();
		expect(decodeFileEditorRecovery(memory.state.raw!, 100).drafts).toHaveLength(1);
		expect(getCachedFileEditorTabs("p:t")[0]?.value).toBe("newer during reset");
	});

	it("does not duplicate a restored record when a confirmed reset aborts and Retry succeeds", async () => {
		const memory = memoryStorage(encodedDraft());
		connect(memory.storage);
		expect(await flush(memory.storage)).toBe(true);
		registerFileEditorScope("p:t", scope);
		expect(restoreFileEditorDraft(getFileEditorDrafts("detached")[0]!)).toBe(true);
		expect(await flush(memory.storage)).toBe(true);
		const restored = getCachedFileEditorTabs("p:t")[0]!;
		memory.state.refuse = true;
		setCachedFileEditorTabs("p:t", [{ ...restored, value: "newer restored content" }]);
		expect(await flush(memory.storage)).toBe(false);
		expect(await resetFileEditorRecoveryStorage(memory.storage)).toBe(false);
		await settle();
		expect(getFileEditorRecoveryCommitStatus(memory.storage).loaded).toBe(true);
		memory.state.refuse = false;
		expect(await retryFileEditorRecoveryStorage(memory.storage)).toBe(true);
		await settle();
		expect(memory.storage.read).toHaveBeenCalledOnce();
		expect(getFileEditorDrafts("detached")).toEqual([]);
		expect(decodeFileEditorRecovery(memory.state.raw!, 100).drafts.map((draft) => draft.tab.value)).toEqual([
			"newer restored content",
		]);
	});

	it("imports legacy only when IDB is missing, removes it after commit ACK, and never falls back from committed empty IDB", async () => {
		const memory = memoryStorage();
		const legacy = { getItem: vi.fn(() => encodedDraft()), removeItem: vi.fn() };
		const commit = deferred<void>();
		memory.storage.write.mockImplementation(async (raw) => {
			await commit.promise;
			memory.state.raw = raw;
		});
		disposers.push(connectFileEditorRecoveryStorage(memory.storage, () => 100, legacy));
		const importing = flushFileEditorRecoveryStorage(memory.storage);
		await settle();
		expect(legacy.removeItem).not.toHaveBeenCalled();
		commit.resolve();
		expect(await importing).toBe(true);
		await settle();
		expect(legacy.removeItem).toHaveBeenCalledExactlyOnceWith(FILE_EDITOR_RECOVERY_KEY);
		discardFileEditorDraft(getFileEditorDrafts("detached")[0]!);
		expect(await flush(memory.storage)).toBe(true);
		for (const dispose of disposers.splice(0)) dispose();
		clearCachedFileEditorTabs();
		const next = memoryStorage(memory.state.raw);
		legacy.getItem.mockClear();
		disposers.push(connectFileEditorRecoveryStorage(next.storage, () => 100, legacy));
		expect(await flush(next.storage)).toBe(true);
		expect(legacy.getItem).not.toHaveBeenCalled();
		expect(getFileEditorDrafts("all")).toEqual([]);
	});

	it("remounts reuse the original writer while an older commit is pending", async () => {
		const memory = memoryStorage();
		const first = connectFileEditorRecoveryStorage(memory.storage, () => 100);
		disposers.push(first);
		expect(await flush(memory.storage)).toBe(true);
		const commits: ReturnType<typeof deferred<void>>[] = [];
		memory.storage.write.mockImplementation(async (raw) => {
			const commit = deferred<void>();
			commits.push(commit);
			await commit.promise;
			memory.state.raw = raw;
		});
		writeDraft("old");
		await settle();
		first();
		connect(memory.storage);
		writeDraft("new");
		await settle();
		expect(commits).toHaveLength(1);
		expect(memory.storage.read).toHaveBeenCalledOnce();
		commits[0]!.resolve();
		await settle();
		expect(commits).toHaveLength(2);
		commits[1]!.resolve();
		expect(await flush(memory.storage)).toBe(true);
		expect(decodeFileEditorRecovery(memory.state.raw!, 100).drafts[0]?.tab.value).toBe("new");
		expect(getFileEditorReviewTarget()).toBeNull();
	});
});
