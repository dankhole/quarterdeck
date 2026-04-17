import { TRPCClientError } from "@trpc/client";
import { createProjectTrpcClient, readTrpcConflictRevision } from "@/runtime/trpc-client";
import type { RuntimeProjectStateResponse, RuntimeProjectStateSaveRequest } from "@/runtime/types";

export class ProjectStateConflictError extends Error {
	readonly currentRevision: number;

	constructor(currentRevision: number, message = "Project state revision conflict.") {
		super(message);
		this.name = "ProjectStateConflictError";
		this.currentRevision = currentRevision;
	}
}

export async function fetchProjectState(projectId: string): Promise<RuntimeProjectStateResponse> {
	const trpcClient = createProjectTrpcClient(projectId);
	return await trpcClient.project.getState.query();
}

export async function saveProjectState(
	projectId: string,
	payload: RuntimeProjectStateSaveRequest,
): Promise<RuntimeProjectStateResponse> {
	const trpcClient = createProjectTrpcClient(projectId);
	try {
		return await trpcClient.project.saveState.mutate(payload);
	} catch (error) {
		if (error instanceof TRPCClientError) {
			const conflictRevision = readTrpcConflictRevision(error);
			if (typeof conflictRevision === "number") {
				throw new ProjectStateConflictError(conflictRevision, error.message);
			}
		}
		throw error;
	}
}
