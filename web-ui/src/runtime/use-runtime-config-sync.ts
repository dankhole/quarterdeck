import { useEffect } from "react";
import { subscribeRuntimeConfigInvalidation } from "@/runtime/runtime-config-invalidation";

export function useRuntimeConfigSync(enabled: boolean, refresh: () => void): void {
	useEffect(() => {
		if (!enabled) return;
		const unsubscribe = subscribeRuntimeConfigInvalidation(refresh);
		const onVisible = () => {
			if (document.visibilityState === "visible") refresh();
		};
		window.addEventListener("focus", refresh);
		document.addEventListener("visibilitychange", onVisible);
		return () => {
			unsubscribe();
			window.removeEventListener("focus", refresh);
			document.removeEventListener("visibilitychange", onVisible);
		};
	}, [enabled, refresh]);
}
