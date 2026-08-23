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

	runIfIdle(projectId: string, taskId: string, operation: () => Promise<void>): Promise<void> | null {
		const key = JSON.stringify([projectId, taskId]);
		if (this.activeKeys.has(key)) {
			return null;
		}

		this.activeKeys.add(key);
		return Promise.resolve()
			.then(operation)
			.finally(() => {
				this.activeKeys.delete(key);
			});
	}
}
