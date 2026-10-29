export interface GitCompareSelection {
	/** Undefined follows the current repository default rather than pinning a stale metadata value. */
	readonly sourceRefOverride?: string;
	readonly targetRefOverride?: string;
	readonly includeUncommitted: boolean;
	readonly threeDotDiff: boolean;
}

export function createGitCompareSelectionKey(
	projectId: string | null,
	taskId: string | null,
	taskCreatedAt?: number,
): string {
	return JSON.stringify([projectId, taskId, taskCreatedAt ?? null]);
}

/** Window-local navigation selections, separate from shared option defaults and review drafts. */
export class GitCompareSelections {
	private readonly selections = new Map<string, GitCompareSelection>();
	private readonly listeners = new Map<string, Set<() => void>>();

	get = (key: string): GitCompareSelection | undefined => this.selections.get(key);

	subscribe = (key: string, listener: () => void): (() => void) => {
		const listeners = this.listeners.get(key) ?? new Set();
		listeners.add(listener);
		this.listeners.set(key, listeners);
		return () => {
			listeners.delete(listener);
			if (!listeners.size) this.listeners.delete(key);
		};
	};

	initialize(key: string, defaults: GitCompareSelection): void {
		if (!this.selections.has(key)) this.update(key, defaults, {});
	}

	update(key: string, defaults: GitCompareSelection, change: Partial<GitCompareSelection>): void {
		this.selections.set(key, { ...(this.get(key) ?? defaults), ...change });
		for (const listener of this.listeners.get(key) ?? []) listener();
	}
}

export const gitCompareSelections = new GitCompareSelections();
