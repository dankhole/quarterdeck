export interface ShellTerminalScope {
	projectId: string;
	taskId: string;
}

export interface ShellTerminalIntent {
	readonly scopeKey: string;
	readonly signal: AbortSignal;
}

interface CancellableShellTerminalIntent extends ShellTerminalIntent {
	cancel: () => void;
}

export function shellTerminalScopeKey(scope: ShellTerminalScope): string {
	return JSON.stringify([scope.projectId, scope.taskId]);
}

/** Browser intent ordering only; process ownership and launch admission belong to the runtime. */
export class ShellTerminalOperations {
	private readonly currentIntents = new Map<string, CancellableShellTerminalIntent>();
	private readonly pendingOperations = new Map<string, Promise<unknown>>();

	begin(scope: ShellTerminalScope): ShellTerminalIntent {
		this.cancel(scope);
		const cancellation = new AbortController();
		const intent = {
			scopeKey: shellTerminalScopeKey(scope),
			signal: cancellation.signal,
			cancel: () => cancellation.abort(),
		};
		this.currentIntents.set(intent.scopeKey, intent);
		return intent;
	}

	isCurrent(intent: ShellTerminalIntent): boolean {
		return this.currentIntents.get(intent.scopeKey) === intent;
	}

	cancel(scope: ShellTerminalScope): void {
		const key = shellTerminalScopeKey(scope);
		this.currentIntents.get(key)?.cancel();
		this.currentIntents.delete(key);
	}

	cancelAll(): void {
		for (const intent of this.currentIntents.values()) intent.cancel();
		this.currentIntents.clear();
	}

	/** A stop must follow an admitted start; a replacement must follow its completed stop. */
	run<T>(scope: ShellTerminalScope, operation: () => Promise<T>): Promise<T> {
		const key = shellTerminalScopeKey(scope);
		const previous = this.pendingOperations.get(key);
		const pending = (previous ? previous.catch(() => {}) : Promise.resolve()).then(operation);
		this.pendingOperations.set(key, pending);
		const clear = () => {
			if (this.pendingOperations.get(key) === pending) {
				this.pendingOperations.delete(key);
			}
		};
		void pending.then(clear, clear);
		return pending;
	}
}
