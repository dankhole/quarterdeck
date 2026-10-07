import {
	type RuntimeNotificationPresentationState,
	runtimeNotificationPresentationStateSchema,
} from "../../../src/core/api/notification-presentation";

let state: RuntimeNotificationPresentationState | null = null;
const listeners = new Set<() => void>();
export function subscribeRuntimeNotificationPresentation(listener: () => void): () => void {
	listeners.add(listener);
	return () => {
		listeners.delete(listener);
	};
}
export function desktopOwnsNotificationPresentation(): boolean {
	return state?.owner === "desktop";
}

/** Only authoritative runtime projection can suppress browser presentation; no renderer election occurs. */
export function applyRuntimeNotificationPresentation(value: unknown): void {
	const parsed = runtimeNotificationPresentationStateSchema.safeParse(value);
	const next = parsed.success ? parsed.data : null;
	if (
		next?.owner === state?.owner &&
		next?.epoch === state?.epoch &&
		next?.runtimeGeneration === state?.runtimeGeneration
	)
		return;
	state = next;
	for (const listener of listeners) listener();
}
