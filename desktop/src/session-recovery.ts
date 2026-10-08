import type { MessageBoxOptions } from "electron";
import type { DesktopStartupFailureMessage } from "../../src/core/api/desktop-runtime-protocol.js";
import type { DesktopRecoveryHelperResult } from "./recovery-helper.js";
import { DESKTOP_ORIGIN } from "./security-policy.js";
import type { DesktopSurface } from "./startup-surface.js";

export const DESKTOP_SESSION_RECOVERY_LAB_DIALOG = "__quarterdeckLabSessionRecoveryDialog";
const RECOVERY_CONFIRMATION_MESSAGE = "Have prior agents and background commands stopped?";

export interface DesktopSessionRecoveryPresentation {
	syntheticLab: boolean;
	showMessage: (options: MessageBoxOptions) => Promise<number>;
	/** Main-only synthetic lab callback; results are checked before authorizing maintenance. */
	labDialog: (options: MessageBoxOptions) => Promise<unknown>;
}

export async function showDesktopSessionRecoveryMessage(
	message: MessageBoxOptions,
	presentation: DesktopSessionRecoveryPresentation,
): Promise<number> {
	if (
		!presentation.syntheticLab ||
		message.title !== "Recover sessions" ||
		message.message !== RECOVERY_CONFIRMATION_MESSAGE
	)
		return await presentation.showMessage(message);
	try {
		const response = await presentation.labDialog(message);
		return response === 1 ? 1 : 0;
	} catch {
		return 0;
	}
}

export interface DesktopSessionRecoveryContext {
	surface: DesktopSurface | "product";
	failureCode: DesktopStartupFailureMessage["code"];
	documentUrl: string;
	senderIsCurrent: boolean;
	busy: boolean;
	runtimeRunning: boolean;
}

export function canRecoverDesktopSessions(context: DesktopSessionRecoveryContext): boolean {
	return (
		context.surface === "startup_failed" &&
		context.failureCode === "recovery_custody_unconfirmed" &&
		context.documentUrl === `${DESKTOP_ORIGIN}/__desktop/error` &&
		context.senderIsCurrent &&
		!context.busy &&
		!context.runtimeRunning
	);
}

export interface DesktopSessionRecoveryOptions {
	isAllowed: () => boolean;
	showMessage: (options: MessageBoxOptions) => Promise<number>;
	runHelper: () => Promise<DesktopRecoveryHelperResult>;
	retryRuntime: () => Promise<void>;
}

/** Main retains its lifecycle gate throughout confirmation and maintenance; only success retries ordinary startup. */
export async function recoverDesktopSessions(options: DesktopSessionRecoveryOptions): Promise<void> {
	if (!options.isAllowed()) return;
	const choice = await options.showMessage({
		type: "warning",
		title: "Recover sessions",
		buttons: ["Cancel", "Confirm Stopped and Recover"],
		defaultId: 0,
		cancelId: 0,
		message: RECOVERY_CONFIRMATION_MESSAGE,
		detail:
			"Older runs cannot account for detached commands. Confirm you stopped any remaining agents or background commands before resuming. Saved projects and session history are retained. If you cannot confirm cleanup, cancel and restart the Mac before reopening Quarterdeck.",
	});
	if (choice !== 1 || !options.isAllowed()) return;
	let result: DesktopRecoveryHelperResult;
	try {
		result = await options.runHelper();
	} catch {
		result = "failed";
	}
	if (result === "recovered") {
		if (options.isAllowed()) await options.retryRuntime();
		return;
	}
	await options.showMessage({
		type: "warning",
		buttons: ["Close"],
		defaultId: 0,
		cancelId: 0,
		message: "Session recovery remains blocked",
		detail:
			result === "timed_out"
				? "The recovery check did not finish in time. Quarterdeck has not resumed sessions. Run quarterdeck recover for the specific check result. Use Help → Export Diagnostics before retrying, or restart the Mac."
				: "A runtime or saved process may still be live, or saved recovery evidence could not be verified. Quarterdeck has not resumed sessions. Stop the prior owner and remaining commands, or restart the Mac. Run quarterdeck recover for the specific check result. Use Help → Export Diagnostics if recovery stays blocked.",
	});
}
