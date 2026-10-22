import { AsyncLocalStorage } from "node:async_hooks";
import { basename } from "node:path";

import { KeyedOperationCoordinator } from "../core/keyed-operation-coordinator";
import { createTaggedLogger } from "../core/runtime-logger";

/** One bounded warning per queued owner; waiting continues afterwards. */
export const IN_PROCESS_LOCK_SLOW_WAIT_MS = 10_000;

const log = createTaggedLogger("locked-file-system");

export class InProcessLockReentryError extends Error {
	constructor(readonly lock: string) {
		super(`Lock "${lock}" is already held by this operation; nested acquisition would deadlock.`);
		this.name = "InProcessLockReentryError";
	}
}

/**
 * Process-wide FIFO turns for serialized lockfiles. Every LockedFileSystem
 * instance shares these owners, and a turn spans the filesystem lock's
 * acquisition through its release.
 */
class InProcessLockOwners {
	private readonly coordinator = new KeyedOperationCoordinator();
	private readonly queued = new Map<string, number>();
	private readonly held = new AsyncLocalStorage<ReadonlyMap<string, { active: boolean }>>();

	async run<T>(key: string, lockfilePath: string, operation: () => Promise<T>): Promise<T> {
		const lock = basename(lockfilePath);
		// Leases end at release, so detached work started under the lock may
		// acquire it later without being mistaken for re-entry.
		if (this.held.getStore()?.get(key)?.active) throw new InProcessLockReentryError(lock);
		this.queued.set(key, (this.queued.get(key) ?? 0) + 1);
		const waitStartedAt = Date.now();
		const slowWait = setTimeout(() => {
			log.warn("in-process lock wait is slow", {
				lock,
				waitMs: Date.now() - waitStartedAt,
				queueDepth: this.queued.get(key) ?? 0,
			});
		}, IN_PROCESS_LOCK_SLOW_WAIT_MS);
		slowWait.unref?.();
		try {
			return await this.coordinator.run(key, async () => {
				clearTimeout(slowWait);
				const owned = new Map(this.held.getStore());
				const lease = { active: true };
				owned.set(key, lease);
				try {
					return await this.held.run(owned, operation);
				} finally {
					lease.active = false;
				}
			});
		} finally {
			clearTimeout(slowWait);
			const remaining = (this.queued.get(key) ?? 1) - 1;
			if (remaining > 0) this.queued.set(key, remaining);
			else this.queued.delete(key);
		}
	}
}

export const inProcessLockOwners = new InProcessLockOwners();
