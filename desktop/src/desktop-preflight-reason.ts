import type { DesktopQuitPreflightRequest } from "../../src/shared/desktop-bridge-contract.js";
import type { DesktopQuitReason } from "./quit-coordinator.js";

/** Only a main-owned clean cleanup receipt permits the renderer's offline draft check for an update. */
export function resolveDesktopFrontendPreflightReason(
	reason: DesktopQuitReason,
	cleanupState: "not_started" | "running" | "clean" | "unconfirmed",
): DesktopQuitPreflightRequest["reason"] {
	if (reason === "restart") return "reload";
	if (reason === "update" && cleanupState === "clean") return "quit";
	return reason;
}
