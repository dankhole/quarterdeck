import { useCallback, useEffect, useRef, useState } from "react";
import { getRuntimeEnvironment } from "@/runtime/runtime-environment";
import {
	type DesktopEnvironmentBridge,
	type DesktopEnvironmentIntent,
	type DesktopEnvironmentSnapshot,
	desktopEnvironmentResponseSchema,
	desktopEnvironmentSnapshotSchema,
	QUARTERDECK_DESKTOP_ENVIRONMENT_BRIDGE_VERSION,
} from "../../../../src/shared/desktop-environment-contract";

declare global {
	interface Window {
		readonly quarterdeckDesktopEnvironment?: DesktopEnvironmentBridge;
	}
}

function getBridge(): DesktopEnvironmentBridge | null {
	const bridge = window.quarterdeckDesktopEnvironment;
	return bridge?.version === QUARTERDECK_DESKTOP_ENVIRONMENT_BRIDGE_VERSION &&
		typeof bridge.getSnapshot === "function" &&
		typeof bridge.request === "function"
		? bridge
		: null;
}

export interface UseDesktopEnvironmentResult {
	readonly visible: boolean;
	readonly snapshot: DesktopEnvironmentSnapshot | null;
	readonly busy: boolean;
	readonly error: string | null;
	readonly message: string | null;
	request: (intent: DesktopEnvironmentIntent) => Promise<void>;
}

/** Native launch preferences stay separate from the shared runtime configuration. */
export function useDesktopEnvironment(open: boolean): UseDesktopEnvironmentResult {
	const visible = getRuntimeEnvironment().kind === "desktop";
	const [snapshot, setSnapshot] = useState<DesktopEnvironmentSnapshot | null>(null);
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [message, setMessage] = useState<string | null>(null);
	const epoch = useRef(0);
	const pending = useRef(false);

	useEffect(() => {
		const current = ++epoch.current;
		pending.current = false;
		setSnapshot(null);
		setError(null);
		setMessage(null);
		setBusy(open && visible);
		if (!open || !visible) return;
		const apply = (value: unknown): void => {
			if (epoch.current !== current) return;
			const parsed = desktopEnvironmentSnapshotSchema.safeParse(value);
			if (parsed.success) setSnapshot(parsed.data);
			else setError("Could not read desktop environment settings. Restart Quarterdeck and try again.");
			setBusy(false);
		};
		const bridge = getBridge();
		if (bridge) void bridge.getSnapshot().then(apply, () => apply(null));
		else apply(null);
		return () => {
			epoch.current += 1;
		};
	}, [open, visible]);

	const request = useCallback(async (intent: DesktopEnvironmentIntent): Promise<void> => {
		const bridge = getBridge();
		if (!bridge || pending.current) return;
		const current = epoch.current;
		pending.current = true;
		setBusy(true);
		setError(null);
		setMessage(null);
		try {
			const response = desktopEnvironmentResponseSchema.safeParse(await bridge.request(intent));
			if (epoch.current !== current) return;
			if (!response.success) {
				setError("Could not update desktop environment settings. Try again.");
				return;
			}
			if (response.data.snapshot) setSnapshot(response.data.snapshot);
			switch (response.data.outcome) {
				case "saved":
					setMessage("Environment settings saved. Refresh the environment or restart Quarterdeck to apply them.");
					break;
				case "refreshed":
					setMessage("Runtime environment refreshed.");
					break;
				case "incomplete":
				case "failed":
					setError("Could not apply the environment change. Check runtime status and try again.");
					break;
				case "unavailable":
					setError(
						"Environment settings are currently unavailable. Wait for runtime operations to finish and try again.",
					);
					break;
				case "cancelled":
					break;
			}
		} catch {
			if (epoch.current === current) setError("Could not update desktop environment settings. Try again.");
		} finally {
			if (epoch.current === current) {
				pending.current = false;
				setBusy(false);
			}
		}
	}, []);

	return { visible, snapshot, busy, error, message, request };
}
