import type { RuntimeAppRouter } from "@runtime-trpc";
import { createTRPCProxyClient, httpBatchLink, TRPCClientError } from "@trpc/client";

interface TrpcErrorDataWithConflictRevision {
	code?: string;
	conflictRevision?: number | null;
}

type RuntimeTrpcClient = ReturnType<typeof createTRPCProxyClient<RuntimeAppRouter>>;

const clientByProjectId = new Map<string, RuntimeTrpcClient>();

export function getRuntimeTrpcClient(projectId: string | null): RuntimeTrpcClient {
	const key = projectId ?? "__unscoped__";
	const existing = clientByProjectId.get(key);
	if (existing) {
		return existing;
	}
	const created = createTRPCProxyClient<RuntimeAppRouter>({
		links: [
			httpBatchLink({
				url: "/api/trpc",
				headers: () => (projectId ? { "x-quarterdeck-project-id": projectId } : {}),
			}),
		],
	});
	clientByProjectId.set(key, created);
	return created;
}

export function createProjectTrpcClient(projectId: string): RuntimeTrpcClient {
	return getRuntimeTrpcClient(projectId);
}

function readTrpcErrorData(error: TRPCClientError<RuntimeAppRouter>): TrpcErrorDataWithConflictRevision | null {
	const data = error.data as TrpcErrorDataWithConflictRevision | undefined;
	if (!data || typeof data !== "object") {
		return null;
	}
	return data;
}

export function readTrpcConflictRevision(error: unknown): number | null {
	if (!(error instanceof TRPCClientError)) {
		return null;
	}
	const data = readTrpcErrorData(error);
	if (data?.code !== "CONFLICT") {
		return null;
	}
	return typeof data.conflictRevision === "number" ? data.conflictRevision : null;
}
