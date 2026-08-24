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

	run<T>(projectId: string | null, taskId: string, operation: () => Promise<T>): Promise<T> {
		return this.operations.run(JSON.stringify([projectId, taskId]), operation);
	}
}
