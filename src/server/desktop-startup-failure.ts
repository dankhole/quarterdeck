import type { DesktopStartupFailureMessage } from "../core/api/desktop-runtime-protocol.js";
import { RuntimeOwnerConnectionError } from "./runtime-owner-client.js";
import { RuntimeOwnershipError } from "./runtime-ownership.js";
import { RuntimeRecoveryAdmissionError } from "./runtime-recovery-admission.js";

export type DesktopStartupFailure = Pick<DesktopStartupFailureMessage, "code" | "message">;

/** Static, actionable text only: never forward paths, credentials, or arbitrary thrown messages. */
export function classifyDesktopStartupFailure(error: unknown): DesktopStartupFailure {
	if (error instanceof RuntimeRecoveryAdmissionError) {
		if (error.reason === "unconfirmed_prior_custody")
			return {
				code: "recovery_custody_unconfirmed",
				message:
					"Quarterdeck cannot confirm cleanup of the previous run. Use Recover sessions after checking prior agents and background commands, or run quarterdeck recover. Your saved projects and sessions are retained.",
			};
		if (error.reason === "live_prior_process")
			return {
				code: "prior_processes_live",
				message:
					"Previous task processes are still running. Inspect Quarterdeck diagnostics and stop those processes before reopening. Your saved sessions are retained.",
			};
		return {
			code: "recovery_evidence_unverifiable",
			message:
				"Quarterdeck could not verify saved process evidence. Inspect diagnostics before retrying; saved sessions have been retained.",
		};
	}
	if (error instanceof RuntimeOwnershipError) {
		if (error.code === "identity_unavailable")
			return {
				code: "identity_unavailable",
				message:
					"Quarterdeck could not verify this Mac or its runtime process. Check system process access and diagnostics, then retry.",
			};
		return {
			code: "ownership_unavailable",
			message:
				"Quarterdeck cannot safely open this state folder. Stop any older Quarterdeck runtime, check diagnostics, then retry. Network-shared state folders are unsupported.",
		};
	}
	if (error instanceof RuntimeOwnerConnectionError)
		return {
			code: error.code,
			message:
				error.code === "incompatible_runtime"
					? "Another Quarterdeck version is running. Quit that runtime and reopen this app, or upgrade the CLI to a compatible version."
					: "Another Quarterdeck runtime is not ready. Wait for it to finish starting or stopping, then retry.",
		};
	return {
		code: "startup_failed",
		message: "Quarterdeck could not initialize its runtime. Inspect Quarterdeck diagnostics, then retry.",
	};
}
