import { useEffect, useState } from "react";

import { fetchClineKanbanAccess } from "@/runtime/runtime-config-query";
import type { RuntimeClineProviderSettings } from "@/runtime/types";

interface UseKanbanAccessGateInput {
	workspaceId: string | null;
	clineProviderSettings: RuntimeClineProviderSettings | null;
}

export function useKanbanAccessGate(input: UseKanbanAccessGateInput): { isBlocked: boolean } {
	const { workspaceId, clineProviderSettings } = input;
	const [isBlocked, setIsBlocked] = useState(false);
	const hasManagedClineOauth =
		clineProviderSettings?.oauthProvider === "cline" && clineProviderSettings.oauthAccessTokenConfigured;

	useEffect(() => {
		if (!hasManagedClineOauth) {
			setIsBlocked(false);
			return;
		}
		let cancelled = false;
		void fetchClineKanbanAccess(workspaceId)
			.then((response) => {
				if (cancelled) {
					return;
				}
				setIsBlocked(!response.enabled);
			})
			.catch(() => {
				if (!cancelled) {
					setIsBlocked(false);
				}
			});
		return () => {
			cancelled = true;
		};
	}, [hasManagedClineOauth, workspaceId]);

	return { isBlocked };
}
