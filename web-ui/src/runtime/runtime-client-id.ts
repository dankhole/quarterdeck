let runtimeClientId: string | null = null;

export function getRuntimeBrowserClientId(): string {
	if (runtimeClientId) {
		return runtimeClientId;
	}
	if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
		runtimeClientId = crypto.randomUUID();
		return runtimeClientId;
	}
	runtimeClientId = `runtime-${Math.random().toString(36).slice(2, 10)}`;
	return runtimeClientId;
}
