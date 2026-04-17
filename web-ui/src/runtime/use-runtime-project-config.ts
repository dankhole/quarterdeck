import { useCallback, useEffect, useRef } from "react";

import { fetchRuntimeConfig } from "@/runtime/runtime-config-query";
import type { RuntimeConfigResponse } from "@/runtime/types";
import { useTrpcQuery } from "@/runtime/use-trpc-query";

export interface UseRuntimeProjectConfigResult {
	config: RuntimeConfigResponse | null;
	isLoading: boolean;
	refresh: () => void;
}

export function useRuntimeProjectConfig(projectId: string | null): UseRuntimeProjectConfigResult {
	const previousProjectIdRef = useRef<string | null>(null);
	const queryFn = useCallback(async () => await fetchRuntimeConfig(projectId), [projectId]);
	const configQuery = useTrpcQuery<RuntimeConfigResponse>({
		enabled: true,
		queryFn,
	});
	const setConfigData = configQuery.setData;

	useEffect(() => {
		const projectChanged = previousProjectIdRef.current !== projectId;
		previousProjectIdRef.current = projectId;
		if (projectChanged) {
			setConfigData(null);
		}
	}, [setConfigData, projectId]);

	const refresh = useCallback(() => {
		void configQuery.refetch();
	}, [configQuery.refetch]);

	return {
		config: configQuery.data,
		isLoading: configQuery.isLoading && configQuery.data === null,
		refresh,
	};
}
