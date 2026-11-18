import type { ReactNode } from "react";

import { QuarterdeckAccessBlockedFallback } from "@/components/app/quarterdeck-access-blocked-fallback";
import { RuntimeDisconnectedFallback } from "@/components/app/runtime-disconnected-fallback";
import { useProjectRuntimeStreamContext } from "@/providers/project-provider";
import { useProjectRuntimeContext } from "@/providers/project-runtime-provider";

export function AppRuntimeBoundary({ children }: { children: ReactNode }): ReactNode {
	const { isRuntimeDisconnected, streamError } = useProjectRuntimeStreamContext();
	const { isQuarterdeckAccessBlocked } = useProjectRuntimeContext();

	if (isQuarterdeckAccessBlocked) return <QuarterdeckAccessBlockedFallback />;

	return (
		<>
			{children}
			{isRuntimeDisconnected && (
				<RuntimeDisconnectedFallback message={streamError ?? undefined} presentation="banner" />
			)}
		</>
	);
}
