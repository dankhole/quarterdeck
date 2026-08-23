// Browser-side query helpers for runtime settings.
// Keep TRPC request details here so components and controller hooks can focus
// on state orchestration instead of transport plumbing.

import { browserHostIntegrations } from "@/runtime/browser-host-integrations";
import { getRuntimeTrpcClient } from "@/runtime/trpc-client";
import type { RuntimeConfigResponse, RuntimeConfigSaveRequest, RuntimeOpenFileResponse } from "@/runtime/types";

function applyRuntimeCapabilities(response: RuntimeConfigResponse): RuntimeConfigResponse {
	browserHostIntegrations.configureCapabilities(response.runtimeCapabilities);
	return response;
}

export async function fetchRuntimeConfig(projectId: string | null): Promise<RuntimeConfigResponse> {
	const trpcClient = getRuntimeTrpcClient(projectId);
	return applyRuntimeCapabilities(await trpcClient.runtime.getConfig.query());
}

export async function saveRuntimeConfig(
	projectId: string | null,
	nextConfig: RuntimeConfigSaveRequest,
): Promise<RuntimeConfigResponse> {
	const trpcClient = getRuntimeTrpcClient(projectId);
	return applyRuntimeCapabilities(await trpcClient.runtime.saveConfig.mutate(nextConfig));
}

export async function setLogLevel(
	projectId: string | null,
	level: "debug" | "info" | "warn" | "error",
): Promise<{ ok: boolean; level: "debug" | "info" | "warn" | "error" }> {
	const trpcClient = getRuntimeTrpcClient(projectId);
	return await trpcClient.runtime.setLogLevel.mutate({ level });
}

export async function openFileOnHost(
	projectId: string | null,
	filePath: string,
): Promise<Extract<RuntimeOpenFileResponse, { ok: true }>> {
	const trpcClient = getRuntimeTrpcClient(projectId);
	const response = await trpcClient.runtime.openFile.mutate({ filePath });
	if (!response.ok) {
		throw new Error(response.error);
	}
	return response;
}
