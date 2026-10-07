export interface AutomaticTitleGenerationRunner {
	runIfIdle(projectId: string, taskId: string, operation: () => Promise<void>): Promise<void> | null;
}

/**
 * Owns automatic title generation single-flight state for one runtime.
 * Request-scoped project APIs share this instance so repeated board saves
 * cannot launch duplicate helpers for the same card.
 */
export class AutomaticTitleGenerationCoordinator implements AutomaticTitleGenerationRunner {
	private readonly activeKeys = new Set<string>();
	private readonly operations = new Set<Promise<void>>();
	private closed = false;

	runIfIdle(projectId: string, taskId: string, operation: () => Promise<void>): Promise<void> | null {
		const key = JSON.stringify([projectId, taskId]);
		if (this.closed || this.activeKeys.has(key)) {
			return null;
		}

		this.activeKeys.add(key);
		const result = Promise.resolve()
			.then(operation)
			.finally(() => {
				this.activeKeys.delete(key);
				this.operations.delete(result);
			});
		this.operations.add(result);
		return result;
	}

	async close(): Promise<void> {
		this.closed = true;
		await Promise.allSettled(Array.from(this.operations));
	}
}
