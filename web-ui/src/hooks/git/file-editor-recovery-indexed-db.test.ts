import { afterEach, describe, expect, it, vi } from "vitest";
import { FILE_EDITOR_RECOVERY_LIMITS } from "./file-editor-recovery";
import {
	createFileEditorRecoveryIndexedDB,
	FILE_EDITOR_RECOVERY_DATABASE,
	FILE_EDITOR_RECOVERY_DATABASE_VERSION,
	FILE_EDITOR_RECOVERY_OBJECT_STORE,
	FILE_EDITOR_RECOVERY_SNAPSHOT_KEY,
} from "./file-editor-recovery-indexed-db";

const emptySnapshot = '{"schemaVersion":1,"drafts":[]}';

/** Explicit events let tests distinguish request success from the later commit acknowledgement. */
function controlledIndexedDB(initial?: unknown, initialized = initial !== undefined) {
	let committed = initial;
	let hasStore = false;
	let durability: string | undefined = "strict";
	let transactionThrows = false;
	let quotaExceeded = false;
	const transactions: ReturnType<typeof createTransaction>[] = [];
	function createTransaction() {
		let pending: unknown;
		let writes = false;
		let aborted = false;
		const request = {
			result: initialized ? { value: committed } : null,
			onsuccess: null as (() => void) | null,
			onerror: null as (() => void) | null,
		};
		const store = {
			openCursor: vi.fn(() => request),
			put: vi.fn((raw: string) => {
				if (quotaExceeded) throw new DOMException("quota", "QuotaExceededError");
				pending = raw;
				writes = true;
				return request;
			}),
		};
		const transaction = {
			durability,
			oncomplete: null as (() => void) | null,
			onabort: null as (() => void) | null,
			onerror: null as (() => void) | null,
			objectStore: vi.fn(() => store),
			abort: vi.fn(() => {
				aborted = true;
				transaction.onabort?.();
			}),
		};
		return {
			transaction,
			request,
			store,
			complete: () => {
				if (aborted) return;
				if (writes) committed = pending;
				transaction.oncomplete?.();
			},
		};
	}
	const database = {
		objectStoreNames: { contains: vi.fn(() => hasStore) },
		createObjectStore: vi.fn(() => {
			hasStore = true;
		}),
		close: vi.fn(),
		onversionchange: null as (() => void) | null,
		onclose: null as (() => void) | null,
		transaction: vi.fn(() => {
			if (transactionThrows) throw new DOMException("unavailable", "InvalidStateError");
			const created = createTransaction();
			transactions.push(created);
			return created.transaction;
		}),
	};
	const upgrade = { abort: vi.fn() };
	const opening = {
		result: database,
		transaction: upgrade,
		onsuccess: null as (() => void) | null,
		onerror: null as (() => void) | null,
		onblocked: null as (() => void) | null,
		onupgradeneeded: null as (() => void) | null,
	};
	const factory = { open: vi.fn(() => opening) };
	return {
		factory: factory as unknown as IDBFactory,
		openSpy: factory.open,
		opening,
		database,
		transactions,
		upgrade,
		getCommitted: () => committed,
		setDurability: (value: string | undefined) => {
			durability = value;
		},
		setTransactionThrows: () => {
			transactionThrows = true;
		},
		setQuotaExceeded: () => {
			quotaExceeded = true;
		},
		opened: () => {
			opening.onupgradeneeded?.();
			opening.onsuccess?.();
		},
	};
}

async function startOperation(memory: ReturnType<typeof controlledIndexedDB>) {
	memory.opened();
	await Promise.resolve();
}
afterEach(() => vi.useRealTimers());

describe("strict desktop IndexedDB recovery backing", () => {
	it("uses one fixed private database and strict transaction, acknowledging only complete", async () => {
		const memory = controlledIndexedDB("previous");
		const backing = createFileEditorRecoveryIndexedDB(memory.factory);
		let acknowledged = false;
		const writing = backing.write(emptySnapshot).then(() => {
			acknowledged = true;
		});
		await startOperation(memory);
		expect(memory.openSpy).toHaveBeenCalledWith(FILE_EDITOR_RECOVERY_DATABASE, FILE_EDITOR_RECOVERY_DATABASE_VERSION);
		expect(memory.database.createObjectStore).toHaveBeenCalledWith(FILE_EDITOR_RECOVERY_OBJECT_STORE);
		expect(memory.database.transaction).toHaveBeenCalledWith(FILE_EDITOR_RECOVERY_OBJECT_STORE, "readwrite", {
			durability: "strict",
		});
		const current = memory.transactions[0]!;
		expect(current.store.put).toHaveBeenCalledWith(emptySnapshot, FILE_EDITOR_RECOVERY_SNAPSHOT_KEY);
		current.request.onsuccess?.();
		await Promise.resolve();
		expect(acknowledged).toBe(false);
		expect(memory.getCommitted()).toBe("previous");
		current.complete();
		await writing;
		expect(acknowledged).toBe(true);
		expect(memory.getCommitted()).toBe(emptySnapshot);
		backing.close();
	});
	it.each([undefined, emptySnapshot])(
		"reads missing vs committed empty without resolving at request success: %s",
		async (raw) => {
			const memory = controlledIndexedDB(raw);
			const backing = createFileEditorRecoveryIndexedDB(memory.factory);
			let acknowledged = false;
			const reading = backing.read().then((value) => {
				acknowledged = true;
				return value;
			});
			await startOperation(memory);
			const current = memory.transactions[0]!;
			current.request.onsuccess?.();
			await Promise.resolve();
			expect(acknowledged).toBe(false);
			current.complete();
			expect(await reading).toBe(raw);
			expect(current.store.openCursor).toHaveBeenCalledWith(FILE_EDITOR_RECOVERY_SNAPSHOT_KEY);
			expect(memory.database.transaction).toHaveBeenCalledWith(FILE_EDITOR_RECOVERY_OBJECT_STORE, "readonly");
			backing.close();
		},
	);
	it.each(["abort", "transaction error", "request error"])(
		"rejects %s after request success and preserves previous committed bytes",
		async (event) => {
			const memory = controlledIndexedDB("previous");
			const backing = createFileEditorRecoveryIndexedDB(memory.factory);
			const writing = backing.write(emptySnapshot);
			const rejected = expect(writing).rejects.toThrow("storage is unavailable");
			await startOperation(memory);
			const current = memory.transactions[0]!;
			current.request.onsuccess?.();
			if (event === "abort") current.transaction.abort();
			else if (event === "transaction error") current.transaction.onerror?.();
			else current.request.onerror?.();
			await rejected;
			current.complete();
			expect(memory.getCommitted()).toBe("previous");
			backing.close();
		},
	);
	it.each(["relaxed", "default", undefined])(
		"aborts unsupported strict durability before issuing a write: %s",
		async (durability) => {
			const memory = controlledIndexedDB("previous");
			memory.setDurability(durability);
			const backing = createFileEditorRecoveryIndexedDB(memory.factory);
			const rejected = expect(backing.write(emptySnapshot)).rejects.toThrow();
			await startOperation(memory);
			await rejected;
			expect(memory.transactions[0]!.store.put).not.toHaveBeenCalled();
			expect(memory.transactions[0]!.transaction.abort).toHaveBeenCalledOnce();
			expect(memory.getCommitted()).toBe("previous");
			backing.close();
		},
	);
	it.each([{}, null, undefined, "x".repeat(FILE_EDITOR_RECOVERY_LIMITS.maxBytes / 2 + 1)])(
		"refuses invalid or oversized stored values without overwriting",
		async (value) => {
			const memory = controlledIndexedDB(value, true);
			const backing = createFileEditorRecoveryIndexedDB(memory.factory);
			const rejected = expect(backing.read()).rejects.toThrow();
			await startOperation(memory);
			memory.transactions[0]!.request.onsuccess?.();
			await rejected;
			expect(memory.getCommitted()).toBe(value);
			backing.close();
		},
	);
	it("rejects oversized writes before opening or replacing stored data", async () => {
		const memory = controlledIndexedDB("previous");
		const backing = createFileEditorRecoveryIndexedDB(memory.factory);
		await expect(backing.write("x".repeat(FILE_EDITOR_RECOVERY_LIMITS.maxBytes / 2 + 1))).rejects.toThrow();
		expect(memory.openSpy).not.toHaveBeenCalled();
		expect(memory.getCommitted()).toBe("previous");
	});
	it("aborts a quota failure and preserves the previously committed snapshot", async () => {
		const memory = controlledIndexedDB("previous");
		memory.setQuotaExceeded();
		const backing = createFileEditorRecoveryIndexedDB(memory.factory);
		const rejected = expect(backing.write(emptySnapshot)).rejects.toThrow();
		await startOperation(memory);
		await rejected;
		expect(memory.transactions[0]!.transaction.abort).toHaveBeenCalledOnce();
		expect(memory.getCommitted()).toBe("previous");
		backing.close();
	});
	it.each(["blocked", "error", "timeout"])(
		"allows explicit retry after %s while retiring the old open request",
		async (event) => {
			vi.useFakeTimers();
			const first = controlledIndexedDB();
			const second = controlledIndexedDB();
			first.openSpy.mockReturnValueOnce(first.opening).mockReturnValueOnce(second.opening);
			const backing = createFileEditorRecoveryIndexedDB(first.factory);
			const rejected = expect(backing.read()).rejects.toThrow();
			if (event === "blocked") first.opening.onblocked?.();
			else if (event === "error") first.opening.onerror?.();
			else await vi.advanceTimersByTimeAsync(5_000);
			await rejected;
			const retry = backing.write(emptySnapshot);
			await startOperation(second);
			first.opened();
			expect(first.database.close).toHaveBeenCalledOnce();
			expect(first.database.transaction).not.toHaveBeenCalled();
			second.transactions[0]!.complete();
			await retry;
			expect(second.getCommitted()).toBe(emptySnapshot);
			backing.close();
		},
	);
	it.each(["blocked", "error", "timeout", "close"])(
		"bounds %s opening and closes late success without a transaction",
		async (event) => {
			vi.useFakeTimers();
			const memory = controlledIndexedDB();
			const backing = createFileEditorRecoveryIndexedDB(memory.factory);
			const rejected = expect(backing.write(emptySnapshot)).rejects.toThrow();
			if (event === "blocked") memory.opening.onblocked?.();
			else if (event === "error") memory.opening.onerror?.();
			else if (event === "close") backing.close();
			else await vi.advanceTimersByTimeAsync(5_000);
			await rejected;
			memory.opened();
			expect(memory.upgrade.abort).toHaveBeenCalledOnce();
			expect(memory.database.close).toHaveBeenCalledOnce();
			expect(memory.database.transaction).not.toHaveBeenCalled();
			if (event === "close") await expect(backing.read()).rejects.toThrow();
			else backing.close();
		},
	);
	it.each(["versionchange", "connection close", "close", "timeout"])(
		"rejects outstanding writes on %s, leaving the previous commit intact",
		async (event) => {
			vi.useFakeTimers();
			const memory = controlledIndexedDB("previous");
			const backing = createFileEditorRecoveryIndexedDB(memory.factory);
			const rejected = expect(backing.write(emptySnapshot)).rejects.toThrow();
			await startOperation(memory);
			if (event === "versionchange") memory.database.onversionchange?.();
			else if (event === "connection close") memory.database.onclose?.();
			else if (event === "close") backing.close();
			else await vi.advanceTimersByTimeAsync(5_000);
			await rejected;
			memory.transactions[0]!.complete();
			expect(memory.getCommitted()).toBe("previous");
			if (event !== "timeout") await expect(backing.write(emptySnapshot)).rejects.toThrow();
			backing.close();
		},
	);
	it("rejects unavailable factories and transaction construction errors", async () => {
		await expect(createFileEditorRecoveryIndexedDB().read()).rejects.toThrow();
		const memory = controlledIndexedDB();
		memory.setTransactionThrows();
		const backing = createFileEditorRecoveryIndexedDB(memory.factory);
		const rejected = expect(backing.write(emptySnapshot)).rejects.toThrow();
		await startOperation(memory);
		await rejected;
		backing.close();
	});
	it("close immediately after open prevents a queued write", async () => {
		const memory = controlledIndexedDB();
		const backing = createFileEditorRecoveryIndexedDB(memory.factory);
		const rejected = expect(backing.write(emptySnapshot)).rejects.toThrow();
		memory.opened();
		backing.close();
		await rejected;
		expect(memory.database.transaction).not.toHaveBeenCalled();
	});
});
