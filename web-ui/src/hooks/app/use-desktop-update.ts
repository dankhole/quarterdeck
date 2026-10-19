import { useCallback, useEffect, useState } from "react";
import { getRuntimeEnvironment } from "@/runtime/runtime-environment";
import {
	type DesktopUpdateBridge,
	type DesktopUpdateSnapshot,
	desktopUpdateSnapshotSchema,
	QUARTERDECK_DESKTOP_UPDATE_BRIDGE_VERSION,
} from "../../../../src/shared/desktop-update-contract";

declare global {
	interface Window {
		readonly quarterdeckDesktopUpdates?: DesktopUpdateBridge;
	}
}

function getUpdateBridge(): DesktopUpdateBridge | null {
	const bridge = window.quarterdeckDesktopUpdates;
	return bridge?.version === QUARTERDECK_DESKTOP_UPDATE_BRIDGE_VERSION &&
		typeof bridge.getSnapshot === "function" &&
		typeof bridge.onSnapshot === "function" &&
		typeof bridge.request === "function"
		? bridge
		: null;
}

export function useDesktopUpdate(): { availableVersion: string | null; showDetails: () => void } {
	const [snapshot, setSnapshot] = useState<DesktopUpdateSnapshot | null>(null);
	useEffect(() => {
		if (getRuntimeEnvironment().kind !== "desktop") return;
		const bridge = getUpdateBridge();
		if (!bridge) return;
		let active = true;
		let receivedPublication = false;
		const apply = (value: unknown): boolean => {
			const parsed = desktopUpdateSnapshotSchema.safeParse(value);
			if (!active || !parsed.success) return false;
			setSnapshot(parsed.data);
			return true;
		};
		// Subscribe first. A newer publication always wins over the initial asynchronous read.
		const unsubscribe = bridge.onSnapshot((value) => {
			if (apply(value)) receivedPublication = true;
		});
		void bridge.getSnapshot().then(
			(value) => {
				if (!receivedPublication) apply(value);
			},
			() => {},
		);
		return () => {
			active = false;
			unsubscribe();
		};
	}, []);
	const showDetails = useCallback(() => {
		if (getRuntimeEnvironment().kind !== "desktop") return;
		void getUpdateBridge()
			?.request("details")
			.catch(() => {});
	}, []);
	return { availableVersion: snapshot?.phase === "available" ? snapshot.availableVersion : null, showDetails };
}
