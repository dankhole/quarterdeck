import {
	buildCompareWindowPath,
	type CompareWindowTarget,
	compareWindowTargetSchema,
} from "../../../../src/shared/compare-window-contract";
import { QUARTERDECK_DESKTOP_COMPARE_BRIDGE_VERSION } from "../../../../src/shared/desktop-bridge-contract";

export type { CompareWindowTarget } from "../../../../src/shared/compare-window-contract";

const READY_TIMEOUT_MS = 15_000;
const READY_MESSAGE = "compare-window-ready";

function readyChannelName(target: CompareWindowTarget): string {
	return `quarterdeck:${buildCompareWindowPath(target)}`;
}

/** A successful noopener open may return null, so acknowledge document startup separately. */
export function announceCompareWindowReady(target: CompareWindowTarget): void {
	if (window.quarterdeckDesktop || typeof BroadcastChannel === "undefined") return;
	const channel = new BroadcastChannel(readyChannelName(target));
	channel.postMessage(READY_MESSAGE);
	channel.close();
}

/** Call directly in the click handler: browser window.open runs before the first await. */
export async function openCompareWindow(input: CompareWindowTarget): Promise<void> {
	const target = compareWindowTargetSchema.parse(input);
	if (window.quarterdeckDesktop) {
		const bridge = window.quarterdeckDesktopCompare;
		if (
			bridge?.version !== QUARTERDECK_DESKTOP_COMPARE_BRIDGE_VERSION ||
			typeof bridge.openCompareWindow !== "function"
		)
			throw new Error("This desktop version cannot open Compare windows. Update Quarterdeck.");
		const response = await bridge.openCompareWindow(target);
		if (response.kind !== "opened")
			throw new Error("Could not open the Compare window. Check the desktop runtime and try again.");
		return;
	}
	if (typeof BroadcastChannel === "undefined") {
		throw new Error(
			"This browser cannot confirm isolated Compare windows. Use a browser with BroadcastChannel support.",
		);
	}
	const url = new URL(buildCompareWindowPath(target), window.location.origin);
	await new Promise<void>((resolve, reject) => {
		const channel = new BroadcastChannel(readyChannelName(target));
		const finish = (error?: Error): void => {
			window.clearTimeout(timeout);
			channel.close();
			if (error) reject(error);
			else resolve();
		};
		const timeout = window.setTimeout(
			() => finish(new Error("The Compare window did not open. Allow popups for Quarterdeck and try again.")),
			READY_TIMEOUT_MS,
		);
		channel.onmessage = (event: MessageEvent<unknown>) => {
			if (event.data === READY_MESSAGE) finish();
		};
		try {
			window.open(url.href, "_blank", "popup,width=1280,height=900,noopener");
		} catch {
			finish(new Error("Could not open the Compare window. Allow popups for Quarterdeck and try again."));
		}
	});
}
