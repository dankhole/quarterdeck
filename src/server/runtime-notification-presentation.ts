import { randomUUID } from "node:crypto";
import type { RuntimeNotificationPresentationState } from "../core/api/notification-presentation";

const PRESENTATION_LEASE_MS = 15_000;

/** Socket-bound presentation ownership; never changes board or session state. */
export class RuntimeNotificationPresentationLease<T extends object> {
	private owner: T | null = null;
	private state: RuntimeNotificationPresentationState;
	private timer: NodeJS.Timeout | null = null;
	private expiresAt = 0;
	private disposed = false;

	constructor(
		readonly runtimeGeneration: string,
		private readonly changed: (state: RuntimeNotificationPresentationState) => void,
		private readonly now: () => number = () => performance.now(),
	) {
		this.state = { owner: "browser", epoch: randomUUID(), runtimeGeneration };
	}

	getState(): RuntimeNotificationPresentationState {
		this.expire();
		return { ...this.state };
	}

	acquire(socket: T): boolean {
		this.expire();
		if (this.disposed || (this.owner !== null && this.owner !== socket)) return false;
		if (this.owner !== socket) {
			this.owner = socket;
			this.state = { owner: "desktop", epoch: randomUUID(), runtimeGeneration: this.runtimeGeneration };
			this.extend();
			this.changed(this.getStateWithoutExpiry());
			return true;
		}
		this.extend();
		return true;
	}

	renew(socket: T, generation: string, epoch: string): boolean {
		this.expire();
		if (generation !== this.runtimeGeneration || epoch !== this.state.epoch) return false;
		return this.acquire(socket);
	}

	release(socket: T): void {
		if (this.owner !== socket) return;
		if (this.timer) clearTimeout(this.timer);
		this.timer = null;
		this.owner = null;
		this.expiresAt = 0;
		this.state = { owner: "browser", epoch: randomUUID(), runtimeGeneration: this.runtimeGeneration };
		if (!this.disposed) this.changed(this.getStateWithoutExpiry());
	}

	dispose(): void {
		this.disposed = true;
		if (this.timer) clearTimeout(this.timer);
		this.timer = null;
		this.owner = null;
	}

	private getStateWithoutExpiry(): RuntimeNotificationPresentationState {
		return { ...this.state };
	}

	private extend(): void {
		this.expiresAt = this.now() + PRESENTATION_LEASE_MS;
		this.scheduleExpiry(PRESENTATION_LEASE_MS);
	}

	private scheduleExpiry(remaining: number): void {
		if (this.timer) clearTimeout(this.timer);
		this.timer = setTimeout(
			() => {
				this.timer = null;
				this.expire();
				// A timer may fire before a sub-millisecond monotonic deadline.
				if (this.owner) this.scheduleExpiry(this.expiresAt - this.now());
			},
			Math.max(1, Math.ceil(remaining)),
		);
		this.timer.unref();
	}

	private expire(): void {
		if (this.owner && this.now() >= this.expiresAt) this.release(this.owner);
	}
}
