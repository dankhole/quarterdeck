export interface AgentLabBrowserCachePaths {
	stablePath: string;
	legacyPath: string;
}

export type AgentLabBrowserCachePreparation = "ready" | "migrated" | "empty";

export function getAgentLabBrowserCachePaths(
	repoRoot: string,
	gitCommonDirectory?: string | null,
): AgentLabBrowserCachePaths;

export function getAgentLabBrowserCachePath(repoRoot: string, gitCommonDirectory?: string | null): string;

export function prepareAgentLabBrowserCache(
	repoRoot: string,
	gitCommonDirectory?: string | null,
): Promise<{ path: string; status: AgentLabBrowserCachePreparation }>;
