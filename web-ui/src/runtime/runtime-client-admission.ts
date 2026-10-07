export const RUNTIME_ADMISSION_REQUIRED_MESSAGE =
	"Your Quarterdeck session has expired or the runtime restarted. Reopen this project from the Quarterdeck CLI or desktop app to connect again. Your unsaved changes remain on this page.";

const listeners = new Set<() => void>();

export function subscribeRuntimeAdmissionRequired(listener: () => void): () => void {
	listeners.add(listener);
	return () => listeners.delete(listener);
}

/** Admission is distinct from an offline runtime. Only the server's scoped 401 asserts it. */
export async function observeRuntimeAdmissionResponse(
	response: Response,
	signal?: AbortSignal | null,
): Promise<boolean> {
	if (response.status !== 401) return false;
	try {
		const payload: unknown = await response.clone().json();
		if (
			payload === null ||
			typeof payload !== "object" ||
			!("code" in payload) ||
			payload.code !== "QUARTERDECK_CLIENT_ACCESS_REQUIRED"
		)
			return false;
	} catch {
		return false;
	}
	if (signal?.aborted) return false;
	for (const listener of listeners) listener();
	return true;
}

/** Browser WebSocket failures hide HTTP status; use one bounded relative read before reconnecting. */
export async function probeRuntimeClientAdmission(signal: AbortSignal): Promise<boolean> {
	try {
		const response = await fetch("/api/trpc/runtime.getConfig", {
			credentials: "same-origin",
			cache: "no-store",
			redirect: "error",
			signal: AbortSignal.any([signal, AbortSignal.timeout(2_000)]),
		});
		if (signal.aborted) return false;
		return await observeRuntimeAdmissionResponse(response, signal);
	} catch {
		return false;
	}
}
