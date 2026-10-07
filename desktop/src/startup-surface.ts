import type { DesktopStartupFailureMessage } from "../../src/core/api/desktop-runtime-protocol.js";
import { desktopCsp } from "./security-policy.js";

export type DesktopSurface = "starting" | "startup_failed" | "runtime_failed" | "renderer_failed" | "shutdown_failed";

const COPY: Record<DesktopSurface, { title: string; detail: string }> = {
	starting: { title: "Starting Quarterdeck", detail: "Preparing the runtime and your workspace…" },
	startup_failed: {
		title: "Quarterdeck could not start",
		detail:
			"The runtime did not become ready. Check the desktop installation and try again. Existing saved workspace state is preserved.",
	},
	runtime_failed: {
		title: "The Quarterdeck runtime stopped",
		detail: "The runtime exited unexpectedly. Restart it explicitly to recover saved workspace state.",
	},
	renderer_failed: {
		title: "The Quarterdeck window stopped",
		detail: "The runtime is still available. Reload the window to recover its saved view.",
	},
	shutdown_failed: {
		title: "Quarterdeck could not finish shutting down",
		detail: "The runtime did not confirm a clean shutdown. Keep the application open and try Quit again.",
	},
};

const FAILURE_COPY: Record<DesktopStartupFailureMessage["code"], string> = {
	startup_failed: COPY.startup_failed.detail,
	ownership_unavailable:
		"Another runtime or maintenance operation owns this workspace. Close that owner or wait for it to finish, then try again. Quarterdeck will not replace an unverified owner.",
	incompatible_runtime:
		"An existing runtime uses an incompatible version. Quit that Quarterdeck CLI or app, then reopen this version. Workspace state will remain available.",
	recovery_custody_unconfirmed:
		"A prior runtime stopped without confirming cleanup. Quarterdeck cannot safely assume its sessions have ended. Restart the Mac to retire those sessions, then reopen Quarterdeck.",
	recovery_evidence_unverifiable:
		"Prior session cleanup cannot be verified from its saved process identities. Quarterdeck will keep recovery blocked. Restart the Mac, then reopen Quarterdeck; if this persists, use diagnostics before retrying.",
	prior_processes_live:
		"Processes from a prior runtime are still running. Quarterdeck will not launch overlapping sessions. Quit the prior owner cleanly, or restart the Mac before reopening.",
	identity_unavailable:
		"Quarterdeck could not verify this Mac's runtime ownership identity. Recovery remains blocked. Restart the Mac and reopen Quarterdeck; use diagnostics if identity verification still fails.",
};

export function startupSurface(
	surface: DesktopSurface,
	failureCode: DesktopStartupFailureMessage["code"] = "startup_failed",
): Response {
	const { title } = COPY[surface];
	const detail = surface === "startup_failed" ? FAILURE_COPY[failureCode] : COPY[surface].detail;
	const action = surface === "renderer_failed" ? "reload" : "retry";
	const label = surface === "renderer_failed" ? "Reload window" : "Try again";
	const link =
		surface === "starting" || surface === "shutdown_failed"
			? ""
			: `<a href="app://quarterdeck/__desktop/${action}">${label}</a>`;
	return new Response(
		`<!doctype html><html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Quarterdeck</title><style>html{color-scheme:dark;background:#24292e;color:#e6edf3;font:16px system-ui}body{margin:0;min-height:100vh;display:grid;place-items:center}main{max-width:34rem;padding:3rem}h1{font-size:1.6rem;font-weight:600}p{line-height:1.65;color:#aeb7c2}a{display:inline-block;padding:.7rem 1rem;border:1px solid #57606a;border-radius:6px;color:#e6edf3;text-decoration:none}a:focus-visible{outline:2px solid #58a6ff;outline-offset:4px}</style></head><body><main role="status"><h1>${title}</h1><p>${detail}</p>${link}</main></body></html>`,
		{
			headers: {
				"Content-Type": "text/html; charset=utf-8",
				"Content-Security-Policy": desktopCsp(null),
				"Cache-Control": "no-store",
				"X-Content-Type-Options": "nosniff",
			},
		},
	);
}
