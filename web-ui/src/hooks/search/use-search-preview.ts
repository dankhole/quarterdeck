import { useEffect, useState } from "react";
import { getRuntimeTrpcClient } from "@/runtime/trpc-client";
import type { RuntimeFileContentResponse } from "@/runtime/types";
import type { WorkdirSearchScope } from "./search-scope";

interface PreviewState {
	key: string;
	content: RuntimeFileContentResponse | null;
	error: boolean;
}

export function useSearchPreview(projectId: string | null, scope: WorkdirSearchScope, path: string | null) {
	const { taskId, baseRef, ref } = scope;
	const key = JSON.stringify([projectId, taskId, baseRef, ref, path]);
	const [state, setState] = useState<PreviewState | null>(null);
	useEffect(() => {
		if (!projectId || !path) return;
		const controller = new AbortController();
		setState(null);
		void getRuntimeTrpcClient(projectId)
			.project.getFileContent.query(
				{ path, taskId, ...(baseRef ? { baseRef } : {}), ...(ref ? { ref } : {}) },
				{ signal: controller.signal },
			)
			.then(
				(content) => {
					if (!controller.signal.aborted) setState({ key, content, error: false });
				},
				() => {
					if (!controller.signal.aborted) setState({ key, content: null, error: true });
				},
			);
		return () => controller.abort();
	}, [projectId, taskId, baseRef, ref, path, key]);
	const current = state?.key === key ? state : null;
	return {
		content: current?.content ?? null,
		isError: current?.error ?? false,
		isLoading: Boolean(projectId && path && !current),
	};
}
