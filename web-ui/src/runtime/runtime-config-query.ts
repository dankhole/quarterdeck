// Browser-side query helpers for runtime settings.
// Keep TRPC request details here so components and controller hooks can focus
// on state orchestration instead of transport plumbing.
import { getRuntimeTrpcClient } from "@/runtime/trpc-client";
import type { RuntimeConfigResponse, RuntimeConfigSaveRequest } from "@/runtime/types";

export async function fetchRuntimeConfig(projectId: string | null): Promise<RuntimeConfigResponse> {
	const trpcClient = getRuntimeTrpcClient(projectId);
	return await trpcClient.runtime.getConfig.query();
}

export async function saveRuntimeConfig(
	projectId: string | null,
	nextConfig: RuntimeConfigSaveRequest,
): Promise<RuntimeConfigResponse> {
	const trpcClient = getRuntimeTrpcClient(projectId);
	return await trpcClient.runtime.saveConfig.mutate(nextConfig);
}

export async function setLogLevel(
	projectId: string | null,
	level: "debug" | "info" | "warn" | "error",
): Promise<{ ok: boolean; level: "debug" | "info" | "warn" | "error" }> {
	const trpcClient = getRuntimeTrpcClient(projectId);
	return await trpcClient.runtime.setLogLevel.mutate({ level });
}

export async function openFileOnHost(projectId: string | null, filePath: string): Promise<void> {
	const trpcClient = getRuntimeTrpcClient(projectId);
	await trpcClient.runtime.openFile.mutate({ filePath });
}
