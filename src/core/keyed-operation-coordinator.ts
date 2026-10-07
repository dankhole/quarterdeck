/**
 * Serializes asynchronous operations by key while allowing unrelated keys to
 * proceed concurrently. Failed operations do not poison later work for the
 * same key.
 */
export class KeyedOperationCoordinator {
	private readonly tails = new Map<string, Promise<void>>();

	run<T>(key: string, operation: () => Promise<T>): Promise<T> {
		const previous = this.tails.get(key) ?? Promise.resolve();
		const result = previous.then(operation, operation);
		const tail = result.then(
			() => undefined,
			() => undefined,
		);
		this.tails.set(key, tail);
		void tail.then(() => {
			if (this.tails.get(key) === tail) {
				this.tails.delete(key);
			}
		});
		return result;
	}

	/** Drain operations already admitted before a composition root closed its ingress. */
	async waitForIdle(): Promise<void> {
		while (this.tails.size > 0) await Promise.all(Array.from(this.tails.values()));
	}
}
