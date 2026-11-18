import { type CompareWindowTarget, compareWindowTargetSchema } from "../../../../src/shared/compare-window-contract";
import { QUARTERDECK_DESKTOP_COMPARE_BRIDGE_VERSION } from "../../../../src/shared/desktop-bridge-contract";

export type { CompareWindowTarget } from "../../../../src/shared/compare-window-contract";

/** Compare windows are separately admitted native renderer documents. */
export async function openCompareWindow(input: CompareWindowTarget): Promise<void> {
	const target = compareWindowTargetSchema.parse(input);
	const bridge = window.quarterdeckDesktopCompare;
	if (bridge?.version !== QUARTERDECK_DESKTOP_COMPARE_BRIDGE_VERSION || typeof bridge.openCompareWindow !== "function")
		throw new Error("This desktop version cannot open Compare windows. Update Quarterdeck.");
	if (target.reviewMode === "uncommitted" && bridge.supportsUncommittedReview !== true)
		throw new Error("This desktop version cannot open Uncommitted reviews. Update Quarterdeck.");
	const response = await bridge.openCompareWindow(target);
	if (response.kind !== "opened")
		throw new Error("Could not open the Compare window. Check the desktop runtime and try again.");
}
