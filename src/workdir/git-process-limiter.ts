/**
 * Admission policy for Git child processes. The limiter only decides when a
 * process may start; command construction, timeouts, and result mapping stay
 * with `runGit`. A non-finite or non-positive limit disables admission control.
 *
 * - `foreground`: short admission and request-path commands (availability, sync, default).
 * - `userAction`: explicit long-running user commands (up to 120 s).
 * - `background`: metadata polling, inspection reads, and remote fetches.
 *
 * Waiters are admitted in that order. `userAction` and `background` may never
 * occupy the slots reserved for `foreground`, so long commands cannot starve
 * admission checks. While `userAction` is capped, background may use shared
 * slots left free by user actions and foreground; sustained foreground load
 * can still exhaust that shared capacity.
 */
export type GitProcessPriority = "foreground" | "userAction" | "background";

const PRIORITY_ORDER: readonly GitProcessPriority[] = ["foreground", "userAction", "background"];

export class GitProcessAdmissionAbortedError extends Error {
	constructor() {
		super("Git command was cancelled before it started.");
		this.name = "GitProcessAdmissionAbortedError";
	}
}

export class GitProcessQueueTimeoutError extends Error {
	constructor(waitedMs: number) {
		super(`Git command waited ${waitedMs}ms for a process slot.`);
		this.name = "GitProcessQueueTimeoutError";
	}
}

export interface GitProcessAdmissionOptions {
	/** Cancels the command while it is still queued. */
	signal?: AbortSignal;
	/** Longest queue wait before the command fails without starting. */
	maxWaitMs?: number;
}

export interface GitProcessLimiterOptions {
	userActionLimit?: number;
}

export interface GitProcessLimiterSnapshot {
	limit: number;
	reservedForegroundSlots: number;
	userActionLimit: number | null;
	active: number;
	activeByPriority: Record<GitProcessPriority, number>;
	queued: Record<GitProcessPriority, number>;
}

interface Waiter {
	start: () => void;
}

export class GitProcessLimiter {
	private active = 0;
	private readonly activeByPriority: Record<GitProcessPriority, number> = {
		foreground: 0,
		userAction: 0,
		background: 0,
	};
	private readonly userActionLimit: number | null;
	private readonly queues: Record<GitProcessPriority, Waiter[]> = { foreground: [], userAction: [], background: [] };
	private readonly reservedForegroundSlots: number;

	constructor(
		private readonly limit: number,
		reservedForegroundSlots = 0,
		options: GitProcessLimiterOptions = {},
	) {
		this.reservedForegroundSlots = Math.max(0, Math.min(reservedForegroundSlots, Math.max(0, limit - 1)));
		this.userActionLimit =
			options.userActionLimit !== undefined && Number.isFinite(options.userActionLimit)
				? Math.max(1, Math.min(Math.floor(options.userActionLimit), limit - this.reservedForegroundSlots))
				: null;
	}

	async run<T>(
		priority: GitProcessPriority,
		operation: () => Promise<T>,
		options: GitProcessAdmissionOptions = {},
	): Promise<T> {
		if (options.signal?.aborted) throw new GitProcessAdmissionAbortedError();
		if (!this.isEnabled()) return await operation();
		await this.acquire(priority, options);
		try {
			if (options.signal?.aborted) throw new GitProcessAdmissionAbortedError();
			return await operation();
		} finally {
			this.active -= 1;
			this.activeByPriority[priority] -= 1;
			this.drain();
		}
	}

	getSnapshot(): GitProcessLimiterSnapshot {
		return {
			limit: this.limit,
			reservedForegroundSlots: this.reservedForegroundSlots,
			userActionLimit: this.userActionLimit,
			active: this.active,
			activeByPriority: { ...this.activeByPriority },
			queued: {
				foreground: this.queues.foreground.length,
				userAction: this.queues.userAction.length,
				background: this.queues.background.length,
			},
		};
	}

	private isEnabled(): boolean {
		return Number.isFinite(this.limit) && this.limit > 0;
	}

	private canStart(priority: GitProcessPriority): boolean {
		const capacity = priority === "foreground" ? this.limit : this.limit - this.reservedForegroundSlots;
		return this.active < capacity && !this.isClassCapped(priority);
	}

	private isClassCapped(priority: GitProcessPriority): boolean {
		return (
			priority === "userAction" &&
			this.userActionLimit !== null &&
			this.activeByPriority.userAction >= this.userActionLimit
		);
	}

	private acquire(priority: GitProcessPriority, options: GitProcessAdmissionOptions): Promise<void> {
		if (this.queues[priority].length === 0 && this.canStart(priority) && !this.hasHigherPriorityWaiter(priority)) {
			this.active += 1;
			this.activeByPriority[priority] += 1;
			return Promise.resolve();
		}
		const { signal, maxWaitMs } = options;
		return new Promise((resolveSlot, rejectSlot) => {
			let deadline: NodeJS.Timeout | null = null;
			const leave = (error: Error) => {
				const queue = this.queues[priority];
				const index = queue.indexOf(waiter);
				if (index < 0) return;
				queue.splice(index, 1);
				if (deadline) clearTimeout(deadline);
				signal?.removeEventListener("abort", onAbort);
				rejectSlot(error);
			};
			const onAbort = () => leave(new GitProcessAdmissionAbortedError());
			const waiter: Waiter = {
				start: () => {
					if (deadline) clearTimeout(deadline);
					signal?.removeEventListener("abort", onAbort);
					resolveSlot();
				},
			};
			signal?.addEventListener("abort", onAbort, { once: true });
			if (maxWaitMs !== undefined && Number.isFinite(maxWaitMs)) {
				deadline = setTimeout(() => leave(new GitProcessQueueTimeoutError(maxWaitMs)), Math.max(0, maxWaitMs));
				deadline.unref?.();
			}
			this.queues[priority].push(waiter);
		});
	}

	private hasHigherPriorityWaiter(priority: GitProcessPriority): boolean {
		for (const candidate of PRIORITY_ORDER) {
			if (candidate === priority) return false;
			if (this.queues[candidate].length > 0 && !this.isClassCapped(candidate)) return true;
		}
		return false;
	}

	private drain(): void {
		for (;;) {
			// A class held at its own cap must not hold up lower-priority work.
			// Otherwise strict priority on the shared process budget is unchanged.
			const priority = PRIORITY_ORDER.find(
				(candidate) => this.queues[candidate].length > 0 && !this.isClassCapped(candidate),
			);
			if (!priority || !this.canStart(priority)) return;
			this.startNext(priority);
		}
	}

	private startNext(priority: GitProcessPriority): void {
		const waiter = this.queues[priority].shift();
		if (!waiter) return;
		this.active += 1;
		this.activeByPriority[priority] += 1;
		waiter.start();
	}
}
