import { useCallback } from "react";
import { fetchRuntimeConfig } from "@/runtime/runtime-config-query";
import type { RuntimeConfigResponse } from "@/runtime/types";
import { useRuntimeConfigSync } from "@/runtime/use-runtime-config-sync";
import { useTrpcQuery } from "@/runtime/use-trpc-query";
import { useProjectMetadataScopeVersion } from "@/stores/project-metadata-store";

export interface UseRuntimeProjectConfigResult {
	config: RuntimeConfigResponse | null;
	isLoading: boolean;
	refresh: () => void;
}

export function useRuntimeProjectConfig(projectId: string | null): UseRuntimeProjectConfigResult {
	const scopeVersion = useProjectMetadataScopeVersion(projectId);
	const queryFn = useCallback(
		async () => ({
			projectId,
			scopeVersion,
			config: await fetchRuntimeConfig(projectId),
		}),
		[projectId, scopeVersion],
	);
	const configQuery = useTrpcQuery({
		enabled: true,
		queryFn,
	});
	const config =
		configQuery.data?.projectId === projectId && configQuery.data.scopeVersion === scopeVersion
			? configQuery.data.config
			: null;

	const refresh = useCallback(() => {
		void configQuery.refetch();
	}, [configQuery.refetch]);

	useRuntimeConfigSync(true, refresh);

	return {
		config,
		isLoading: configQuery.isLoading && config === null,
		refresh,
	};
}
