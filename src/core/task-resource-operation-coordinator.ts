import { KeyedOperationCoordinator } from "./keyed-operation-coordinator";

export interface TaskResourceOperationRunner {
	run<T>(projectId: string | null, taskId: string, operation: () => Promise<T>): Promise<T>;
}

/**
 * Serializes operations that can create, launch from, stop within, or delete
 * one task's checkout. Browser and server each own an instance at their
 * composition root so the same project/task key semantics protect both sides
 * of the request boundary without sharing mutable state between runtimes.
 */
export class TaskResourceOperationCoordinator implements TaskResourceOperationRunner {
	private readonly operations = new KeyedOperationCoordinator();

	run<T>(projectId: string | null, taskId: string, operation: () => Promise<T>): Promise<T> {
		return this.operations.run(JSON.stringify([projectId, taskId]), operation);
	}
}
