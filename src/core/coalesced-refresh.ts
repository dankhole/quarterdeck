/**
 * Runs at most one task at a time. Callers arriving while one runs share a
 * single follow-up run that starts after it, so each caller observes state at
 * least as new as its own request without a build per caller.
 */
export class CoalescedRefresh<T> {
	private running: Promise<T> | null = null;
	private followUp: Promise<T> | null = null;

	run(task: () => Promise<T>): Promise<T> {
		const running = this.running;
		if (!running) return this.start(task);
		if (!this.followUp) {
			const settled = running.then(
				() => undefined,
				() => undefined,
			);
			this.followUp = settled.then(() => {
				this.followUp = null;
				return this.start(task);
			});
		}
		return this.followUp;
	}

	private start(task: () => Promise<T>): Promise<T> {
		const promise = Promise.resolve().then(task);
		this.running = promise;
		const clear = () => {
			if (this.running === promise) this.running = null;
		};
		promise.then(clear, clear);
		return promise;
	}
}
