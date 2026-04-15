// Browser-side query helpers for runtime settings.
// Keep TRPC request details here so components and controller hooks can focus
// on state orchestration instead of transport plumbing.
import { getRuntimeTrpcClient } from "@/runtime/trpc-client";
import type { RuntimeConfigResponse, RuntimeConfigSaveRequest } from "@/runtime/types";

export async function fetchRuntimeConfig(workspaceId: string | null): Promise<RuntimeConfigResponse> {
	const trpcClient = getRuntimeTrpcClient(workspaceId);
	return await trpcClient.runtime.getConfig.query();
}

export async function saveRuntimeConfig(
	workspaceId: string | null,
	nextConfig: RuntimeConfigSaveRequest,
): Promise<RuntimeConfigResponse> {
	const trpcClient = getRuntimeTrpcClient(workspaceId);
	return await trpcClient.runtime.saveConfig.mutate(nextConfig);
}

export async function setLogLevel(
	workspaceId: string | null,
	level: "debug" | "info" | "warn" | "error",
): Promise<{ ok: boolean; level: "debug" | "info" | "warn" | "error" }> {
	const trpcClient = getRuntimeTrpcClient(workspaceId);
	return await trpcClient.runtime.setLogLevel.mutate({ level });
}

export async function openFileOnHost(workspaceId: string | null, filePath: string): Promise<void> {
	const trpcClient = getRuntimeTrpcClient(workspaceId);
	await trpcClient.runtime.openFile.mutate({ filePath });
}
