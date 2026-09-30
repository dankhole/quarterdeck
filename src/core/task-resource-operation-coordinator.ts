import { AsyncLocalStorage } from "node:async_hooks";
import { KeyedOperationCoordinator } from "./keyed-operation-coordinator";

export interface TaskResourceOperationRunner {
	run<T>(projectId: string | null, taskId: string, operation: () => Promise<T>): Promise<T>;
}

/**
 * Serializes operations that can create, launch from, stop within, or delete
 * one task's checkout. The runtime composition root owns the production
 * instance so lifecycle commands and lower-level server handlers share one
 * project/task boundary across every client.
 */
export class TaskResourceOperationCoordinator implements TaskResourceOperationRunner {
	private readonly operations = new KeyedOperationCoordinator();
	private readonly projectGates = new Map<string, ProjectOperationGate>();
	private readonly ownership = new AsyncLocalStorage<ReadonlyMap<string, { active: boolean }>>();

	run<T>(projectId: string | null, taskId: string, operation: () => Promise<T>): Promise<T> {
		return this.runProject(projectId, () => this.operations.run(JSON.stringify([projectId, taskId]), operation));
	}

	/** Shared admission for a complete operation, including its asynchronous effects. */
	runProject<T>(projectId: string | null, operation: () => Promise<T>): Promise<T> {
		if (!projectId || this.ownership.getStore()?.get(projectId)?.active) return operation();
		return this.getGate(projectId).runShared(() => this.withOwnership(projectId, operation));
	}

	/** Drains admitted work before relocation, and fences later operations until it finishes. */
	runProjectExclusive<T>(projectId: string, operation: () => Promise<T>): Promise<T> {
		if (this.ownership.getStore()?.get(projectId)?.active) {
			throw new Error("Cannot begin a project relocation inside an admitted project operation.");
		}
		return this.getGate(projectId).runExclusive(() => this.withOwnership(projectId, operation));
	}

	private async withOwnership<T>(projectId: string, operation: () => Promise<T>): Promise<T> {
		const owned = new Map(this.ownership.getStore());
		const lease = { active: true };
		owned.set(projectId, lease);
		try {
			return await this.ownership.run(owned, operation);
		} finally {
			lease.active = false;
		}
	}

	private getGate(projectId: string): ProjectOperationGate {
		let gate = this.projectGates.get(projectId);
		if (!gate) {
			gate = new ProjectOperationGate();
			this.projectGates.set(projectId, gate);
		}
		return gate;
	}
}

/** Fair shared/exclusive queue: an exclusive request fences all subsequently admitted readers. */
class ProjectOperationGate {
	private barrier: Promise<void> = Promise.resolve();
	private readonly admitted = new Set<Promise<unknown>>();

	runShared<T>(operation: () => Promise<T>): Promise<T> {
		const result = this.barrier.then(operation);
		this.admitted.add(result);
		void result.then(
			() => this.admitted.delete(result),
			() => this.admitted.delete(result),
		);
		return result;
	}

	runExclusive<T>(operation: () => Promise<T>): Promise<T> {
		const previous = this.barrier;
		const admitted = [...this.admitted];
		const result = Promise.allSettled([previous, ...admitted]).then(operation);
		this.barrier = result.then(
			() => undefined,
			() => undefined,
		);
		return result;
	}
}
