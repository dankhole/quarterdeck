import {
	type FileEditorDraft,
	getFileEditorDrafts,
	hydrateFileEditorRecovery,
	setFileEditorRecoveryStatus,
	subscribeFileEditorCache,
} from "./file-editor-cache";
import {
	decodeFileEditorRecovery,
	encodeFileEditorRecovery,
	FILE_EDITOR_RECOVERY_KEY,
	type FileEditorRecoveryProblem,
	type FileEditorRecoveryRecord,
} from "./file-editor-recovery";

export interface FileEditorRecoveryStorage {
	read(): Promise<string | undefined>;
	write(raw: string): Promise<void>;
}
export interface FileEditorLegacyRecoveryStorage {
	getItem(key: string): string | null;
	removeItem(key: string): void;
}
export interface FileEditorRecoveryCommitStatus {
	readonly loaded: boolean;
	readonly pending: boolean;
	readonly busy: boolean;
	readonly problem: FileEditorRecoveryProblem | null;
	readonly desiredRevision: number;
	readonly committedRevision: number;
	readonly ready: boolean;
}

// Only persisted content and identity define a revision; status/review changes
// must not produce another write or refresh a draft's expiry timestamp.
function semanticSnapshot(drafts: readonly FileEditorDraft[]): string {
	return JSON.stringify(
		drafts
			.filter(({ tab }) => tab.value !== tab.savedValue)
			.map(({ scopeKey, scope, generation, recoveryId, tab }) => ({
				id: recoveryId ?? JSON.stringify([scopeKey, generation, tab.path]),
				scopeKey,
				scope,
				tab: {
					path: tab.path,
					value: tab.value,
					savedValue: tab.savedValue,
					contentHash: tab.contentHash,
					language: tab.language,
					binary: tab.binary,
					truncated: tab.truncated,
					editable: tab.editable,
					editBlockedReason: tab.editBlockedReason,
					size: tab.size,
				},
			})),
	);
}

class RecoverySession {
	private records: readonly FileEditorRecoveryRecord[] = [];
	private drafts: readonly FileEditorDraft[] = [];
	private semantic = "";
	private desiredRevision = 0;
	private committedRevision = 0;
	private failedRevision = -1;
	private loaded = false;
	private quarantined = false;
	private problem: FileEditorRecoveryProblem | null = null;
	private expired = 0;
	private reading?: Promise<boolean>;
	private writing = false;
	private actionPending = false;
	private resetting = false;
	private removeLegacyAfterCommit = false;
	private references = 0;
	private unsubscribe?: () => void;
	private readonly waiters = new Set<{ target: number; resolve: (committed: boolean) => void }>();

	constructor(
		private readonly storage: FileEditorRecoveryStorage,
		private readonly now: () => number,
		private readonly legacy?: FileEditorLegacyRecoveryStorage,
	) {}

	status(): FileEditorRecoveryCommitStatus {
		const busy = !!this.reading || this.writing || this.actionPending;
		const pending = busy || this.desiredRevision > this.committedRevision;
		return {
			loaded: this.loaded,
			pending,
			busy,
			problem: this.problem,
			desiredRevision: this.desiredRevision,
			committedRevision: this.committedRevision,
			ready: this.loaded && !pending && this.problem === null,
		};
	}

	private publish(): void {
		const status = this.status();
		setFileEditorRecoveryStatus(
			this.problem,
			this.expired,
			this.quarantined,
			status.pending || !this.loaded,
			status.busy,
		);
	}

	private capture(force = false): void {
		const drafts = getFileEditorDrafts("all");
		const semantic = semanticSnapshot(drafts);
		if (!force && semantic === this.semantic) return;
		this.semantic = semantic;
		this.drafts = drafts;
		this.desiredRevision++;
		this.publish();
		this.pump();
	}

	private settleWaiters(failedThrough = -1): void {
		for (const waiter of this.waiters) {
			if (this.committedRevision >= waiter.target || waiter.target <= failedThrough || this.quarantined) {
				this.waiters.delete(waiter);
				waiter.resolve(this.committedRevision >= waiter.target);
			}
		}
	}

	private pump(): void {
		if (
			(!this.loaded && !this.resetting) ||
			this.quarantined ||
			this.writing ||
			this.desiredRevision <= this.committedRevision ||
			this.desiredRevision <= this.failedRevision
		)
			return;
		const revision = this.desiredRevision;
		const encoded = encodeFileEditorRecovery(this.drafts, this.records, this.now());
		if (!encoded.ok) {
			this.failedRevision = revision;
			this.problem = encoded.problem;
			if (this.resetting) {
				this.resetting = false;
				this.quarantined = !this.loaded;
			}
			this.publish();
			this.settleWaiters(revision);
			return;
		}
		this.writing = true;
		this.publish();
		void Promise.resolve()
			.then(() => this.storage.write(encoded.raw))
			.then(
				() => {
					this.records = encoded.drafts;
					this.committedRevision = revision;
					this.loaded = true;
					this.resetting = false;
					this.problem = null;
					if (this.removeLegacyAfterCommit) {
						this.removeLegacyAfterCommit = false;
						try {
							this.legacy?.removeItem(FILE_EDITOR_RECOVERY_KEY);
						} catch {
							/* The committed IDB record is authoritative. */
						}
					}
					this.settleWaiters();
				},
				() => {
					this.failedRevision = revision;
					this.problem = "storage";
					if (this.resetting) {
						this.resetting = false;
						this.quarantined = !this.loaded;
					}
					this.settleWaiters(revision);
				},
			)
			.finally(() => {
				this.writing = false;
				this.publish();
				this.pump();
			});
	}

	private initialize(retry = false): Promise<boolean> {
		if (this.reading) return this.reading;
		if (this.resetting) return Promise.resolve(true);
		if (this.loaded) return Promise.resolve(true);
		if (this.quarantined && !retry) return Promise.resolve(false);
		this.reading = Promise.resolve()
			.then(async () => {
				try {
					const stored = await this.storage.read();
					const raw = stored === undefined ? (this.legacy?.getItem(FILE_EDITOR_RECOVERY_KEY) ?? null) : stored;
					const loaded = decodeFileEditorRecovery(raw, this.now());
					if (loaded.problem) {
						this.problem = loaded.problem;
						this.quarantined = true;
						return false;
					}
					this.records = loaded.drafts;
					this.expired = loaded.expired;
					// Hydration and edits made during the read join one snapshot while
					// writes are still fenced. Recovered text never overwrites live tabs.
					hydrateFileEditorRecovery(loaded.drafts);
					this.loaded = true;
					this.quarantined = false;
					this.problem = null;
					this.removeLegacyAfterCommit = stored === undefined && raw !== null;
					this.capture(true);
					return true;
				} catch {
					this.problem = "storage";
					this.quarantined = true;
					return false;
				}
			})
			.finally(() => {
				this.reading = undefined;
				this.publish();
				this.settleWaiters();
			});
		this.publish();
		return this.reading;
	}

	connect(): () => void {
		if (this.references++ === 0) this.unsubscribe = subscribeFileEditorCache(() => this.capture());
		this.capture();
		void this.initialize();
		let connected = true;
		return () => {
			if (!connected) return;
			connected = false;
			if (--this.references === 0) {
				this.unsubscribe?.();
				this.unsubscribe = undefined;
			}
		};
	}

	async flush(): Promise<boolean> {
		this.capture();
		const target = this.desiredRevision;
		if (!(await this.initialize())) return false;
		return this.waitForRevision(target);
	}

	private waitForRevision(target: number): Promise<boolean> {
		if (this.committedRevision >= target) return Promise.resolve(true);
		if (this.quarantined || this.failedRevision >= target) return Promise.resolve(false);
		return new Promise((resolve) => {
			this.waiters.add({ target, resolve });
			this.pump();
		});
	}

	async retry(): Promise<boolean> {
		if (this.actionPending) return false;
		this.actionPending = true;
		this.publish();
		try {
			if (!(await this.initialize(true))) return false;
			this.failedRevision = -1;
			this.capture();
			this.pump();
			return await this.waitForRevision(this.desiredRevision);
		} finally {
			this.actionPending = false;
			this.publish();
		}
	}

	async reset(): Promise<boolean> {
		if (this.actionPending || this.writing) return false;
		this.actionPending = true;
		this.publish();
		try {
			await this.reading;
			if (this.writing) return false;
			this.resetting = true;
			this.quarantined = false;
			this.failedRevision = -1;
			this.removeLegacyAfterCommit = true;
			this.expired = 0;
			this.capture(true);
			return await this.waitForRevision(this.desiredRevision);
		} finally {
			this.actionPending = false;
			this.publish();
		}
	}
}

const sessions = new WeakMap<FileEditorRecoveryStorage, RecoverySession>();

/** One writer survives remounts; cleanup detaches listeners without replacing its pending session. */
export function connectFileEditorRecoveryStorage(
	storage: FileEditorRecoveryStorage,
	now: () => number = Date.now,
	legacy?: FileEditorLegacyRecoveryStorage,
): () => void {
	let session = sessions.get(storage);
	if (!session) {
		session = new RecoverySession(storage, now, legacy);
		sessions.set(storage, session);
	}
	return session.connect();
}

export function getFileEditorRecoveryCommitStatus(storage: FileEditorRecoveryStorage): FileEditorRecoveryCommitStatus {
	return (
		sessions.get(storage)?.status() ?? {
			loaded: false,
			pending: true,
			busy: false,
			problem: null,
			desiredRevision: 0,
			committedRevision: 0,
			ready: false,
		}
	);
}
export async function flushFileEditorRecoveryStorage(storage: FileEditorRecoveryStorage): Promise<boolean> {
	return (await sessions.get(storage)?.flush()) ?? false;
}
export async function retryFileEditorRecoveryStorage(storage: FileEditorRecoveryStorage): Promise<boolean> {
	return (await sessions.get(storage)?.retry()) ?? false;
}
/** Caller confirms overwriting an unreadable snapshot; success requires strict commit ACK. */
export async function resetFileEditorRecoveryStorage(storage: FileEditorRecoveryStorage): Promise<boolean> {
	return (await sessions.get(storage)?.reset()) ?? false;
}
