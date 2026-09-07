import type { TaskExecutionOwnership } from "../execution/execution-ownership-contracts";

export interface NativeInputAuthorization {
	read(): Promise<TaskExecutionOwnership | null>;
	isCurrent(ownership: TaskExecutionOwnership | null): boolean;
	dispose(): void;
}

interface Subscription {
	taskId: string;
	value: TaskExecutionOwnership | null | undefined;
	token: string | undefined;
	version: number;
}

function authorityIdentity(owner: TaskExecutionOwnership | null): string {
	if (!owner) return "absent";
	return JSON.stringify([
		owner.state,
		owner.ownerGeneration,
		owner.ownerSessionInstanceId,
		owner.ownerProcess,
		owner.provider,
		owner.providerSessionId,
		owner.providerProfileFingerprint,
		owner.pendingHandoff,
	]);
}

/**
 * Connection-scoped observations, never a replacement for durable lifecycle reads.
 * Each read checks journal file identity to detect other runtimes' commits.
 * The caller must also fence each use to its exact live native PTY.
 * No observation survives disposal of its input connection.
 */
export class NativeInputAuthorizationSubscriptions {
	private readonly projects = new Map<string, Set<Subscription>>();

	create(
		projectId: string,
		taskId: string,
		verify: () => Promise<unknown>,
		readToken: () => Promise<string>,
	): NativeInputAuthorization {
		const subscription: Subscription = { taskId, value: undefined, token: undefined, version: 0 };
		let subscriptions = this.projects.get(projectId);
		if (!subscriptions) {
			subscriptions = new Set();
			this.projects.set(projectId, subscriptions);
		}
		subscriptions.add(subscription);
		let disposed = false;
		return {
			isCurrent: (ownership) =>
				!disposed &&
				subscription.value !== undefined &&
				authorityIdentity(subscription.value) === authorityIdentity(ownership),
			read: async () => {
				while (!disposed) {
					if (subscription.value !== undefined) {
						const version = subscription.version;
						let token: string;
						try {
							token = await readToken();
						} catch (error) {
							if (disposed || version !== subscription.version) continue;
							this.invalidateSubscription(subscription);
							throw error;
						}
						if (disposed || version !== subscription.version) continue;
						if (token === subscription.token) return structuredClone(subscription.value);
						this.invalidateSubscription(subscription);
					}
					// verify publishes under the durable lock. Do not install its return
					// value: another mutation may have invalidated it while lock release
					// was awaited. Recheck the current observation instead.
					await verify();
				}
				throw new Error("Native input authorization has been disposed.");
			},
			dispose: () => {
				if (disposed) return;
				disposed = true;
				subscriptions.delete(subscription);
				if (subscriptions.size === 0) this.projects.delete(projectId);
			},
		};
	}

	publish(projectId: string, owners: Record<string, TaskExecutionOwnership>, token: string): void {
		for (const subscription of this.projects.get(projectId) ?? []) {
			subscription.value = structuredClone(owners[subscription.taskId] ?? null);
			subscription.token = token;
			subscription.version++;
		}
	}

	invalidateChanged(projectId: string, owners: Record<string, TaskExecutionOwnership>): void {
		for (const subscription of this.projects.get(projectId) ?? []) {
			if (
				subscription.value !== undefined &&
				authorityIdentity(subscription.value) !== authorityIdentity(owners[subscription.taskId] ?? null)
			) {
				this.invalidateSubscription(subscription);
			}
		}
	}

	private invalidateSubscription(subscription: Subscription): void {
		subscription.value = undefined;
		subscription.token = undefined;
		subscription.version++;
	}

	invalidate(projectId: string): void {
		for (const subscription of this.projects.get(projectId) ?? []) this.invalidateSubscription(subscription);
	}
}
