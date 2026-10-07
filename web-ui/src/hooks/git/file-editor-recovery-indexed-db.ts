import {
	FILE_EDITOR_RECOVERY_DATABASE,
	FILE_EDITOR_RECOVERY_DATABASE_VERSION,
	FILE_EDITOR_RECOVERY_OBJECT_STORE,
	FILE_EDITOR_RECOVERY_SNAPSHOT_KEY,
} from "../../../../src/shared/file-editor-recovery-storage-contract.js";
import { FILE_EDITOR_RECOVERY_LIMITS } from "./file-editor-recovery";

export {
	FILE_EDITOR_RECOVERY_DATABASE,
	FILE_EDITOR_RECOVERY_DATABASE_VERSION,
	FILE_EDITOR_RECOVERY_OBJECT_STORE,
	FILE_EDITOR_RECOVERY_SNAPSHOT_KEY,
};

const STORAGE_TIMEOUT_MS = 5_000;

export interface FileEditorRecoveryIndexedDB {
	/** Undefined means never initialized. A committed empty snapshot remains authoritative. */
	read(): Promise<string | undefined>;
	/** Acknowledges transaction completion, never an individual request's success. */
	write(raw: string): Promise<void>;
	/** Terminal: aborts outstanding transactions and rejects future operations. */
	close(): void;
}

/** Desktop-only backing mechanism. The caller owns schema validation, migration and write ordering. */
export function createFileEditorRecoveryIndexedDB(factory?: IDBFactory): FileEditorRecoveryIndexedDB {
	let closed = false;
	let database: IDBDatabase | undefined;
	let opening: Promise<IDBDatabase> | undefined;
	let cancelOpening: (() => void) | undefined;
	const cancelTransactions = new Set<() => void>();
	const failure = () => new Error("Desktop file recovery storage is unavailable.");
	const close = () => {
		closed = true;
		cancelOpening?.();
		for (const cancel of [...cancelTransactions]) cancel();
		database?.close();
		database = undefined;
	};
	const open = (): Promise<IDBDatabase> => {
		if (closed) return Promise.reject(failure());
		if (opening) return opening;
		const pending = new Promise<IDBDatabase>((resolve, reject) => {
			let request: IDBOpenDBRequest;
			try {
				const available = factory ?? globalThis.indexedDB;
				if (!available) throw failure();
				request = available.open(FILE_EDITOR_RECOVERY_DATABASE, FILE_EDITOR_RECOVERY_DATABASE_VERSION);
			} catch {
				reject(failure());
				return;
			}
			let settled = false;
			const fail = () => {
				if (settled) return;
				settled = true;
				clearTimeout(timer);
				cancelOpening = undefined;
				reject(failure());
			};
			const timer = setTimeout(fail, STORAGE_TIMEOUT_MS);
			cancelOpening = fail;
			request.onblocked = fail;
			request.onerror = fail;
			request.onupgradeneeded = () => {
				if (closed || settled) {
					request.transaction?.abort();
					return;
				}
				if (!request.result.objectStoreNames.contains(FILE_EDITOR_RECOVERY_OBJECT_STORE))
					request.result.createObjectStore(FILE_EDITOR_RECOVERY_OBJECT_STORE);
			};
			request.onsuccess = () => {
				const result = request.result;
				if (closed || settled || !result.objectStoreNames.contains(FILE_EDITOR_RECOVERY_OBJECT_STORE)) {
					result.close();
					fail();
					return;
				}
				settled = true;
				clearTimeout(timer);
				cancelOpening = undefined;
				database = result;
				result.onversionchange = close;
				result.onclose = close;
				resolve(result);
			};
		});
		opening = pending;
		void pending.catch(() => {
			if (opening === pending) opening = undefined;
		});
		return pending;
	};
	const transact = async (raw?: string): Promise<string | undefined> => {
		if (raw !== undefined && raw.length * 2 > FILE_EDITOR_RECOVERY_LIMITS.maxBytes) throw failure();
		const db = await open();
		if (closed) throw failure();
		return new Promise((resolve, reject) => {
			let transaction: IDBTransaction;
			try {
				transaction =
					raw === undefined
						? db.transaction(FILE_EDITOR_RECOVERY_OBJECT_STORE, "readonly")
						: db.transaction(FILE_EDITOR_RECOVERY_OBJECT_STORE, "readwrite", { durability: "strict" });
			} catch {
				reject(failure());
				return;
			}
			let settled = false;
			let value: string | undefined;
			const finish = (error: boolean) => {
				if (settled) return;
				settled = true;
				clearTimeout(timer);
				cancelTransactions.delete(cancel);
				if (error) reject(failure());
				else resolve(value);
			};
			const cancel = () => {
				try {
					transaction.abort();
				} catch {
					// A finished transaction cannot be aborted, but is never acknowledged after cancellation.
				}
				finish(true);
			};
			const timer = setTimeout(cancel, STORAGE_TIMEOUT_MS);
			cancelTransactions.add(cancel);
			transaction.onabort = () => finish(true);
			transaction.onerror = cancel;
			transaction.oncomplete = () => finish(false);
			try {
				if (raw !== undefined && transaction.durability !== "strict") {
					cancel();
					return;
				}
				const store = transaction.objectStore(FILE_EDITOR_RECOVERY_OBJECT_STORE);
				if (raw !== undefined) {
					store.put(raw, FILE_EDITOR_RECOVERY_SNAPSHOT_KEY).onerror = cancel;
				} else {
					const request = store.openCursor(FILE_EDITOR_RECOVERY_SNAPSHOT_KEY);
					request.onerror = cancel;
					request.onsuccess = () => {
						const cursor = request.result;
						if (cursor === null) return;
						const result: unknown = cursor.value;
						if (typeof result !== "string" || result.length * 2 > FILE_EDITOR_RECOVERY_LIMITS.maxBytes) cancel();
						else value = result;
					};
				}
			} catch {
				cancel();
			}
		});
	};
	return {
		read: () => transact(),
		write: async (raw) => {
			await transact(raw);
		},
		close,
	};
}
