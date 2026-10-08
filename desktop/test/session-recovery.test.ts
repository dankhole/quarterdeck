import type { MessageBoxOptions } from "electron";
import { describe, expect, it, vi } from "vitest";
import {
	canRecoverDesktopSessions,
	type DesktopSessionRecoveryContext,
	recoverDesktopSessions,
	showDesktopSessionRecoveryMessage,
} from "../src/session-recovery.js";
import { desktopSurfaceAction, startupSurface } from "../src/startup-surface.js";

function context(): DesktopSessionRecoveryContext {
	return {
		surface: "startup_failed",
		failureCode: "recovery_custody_unconfirmed",
		documentUrl: "app://quarterdeck/__desktop/error",
		senderIsCurrent: true,
		busy: false,
		runtimeRunning: false,
	};
}

function recovery(choice = 1) {
	const state = context();
	const messages: MessageBoxOptions[] = [];
	const showMessage = vi.fn(async (message: MessageBoxOptions) => {
		messages.push(message);
		return choice;
	});
	const runHelper = vi.fn(async () => "recovered" as const);
	const retryRuntime = vi.fn(async () => undefined);
	return {
		state,
		messages,
		options: { isAllowed: () => canRecoverDesktopSessions(state), showMessage, runHelper, retryRuntime },
	};
}

describe("explicit desktop prior-session recovery", () => {
	it("exposes synthetic confirmation only to the verified lab recovery flow", async () => {
		const fixture = recovery(0);
		await recoverDesktopSessions(fixture.options);
		const confirmation = fixture.messages[0];
		if (!confirmation) throw new Error("Expected recovery confirmation.");
		const showMessage = vi.fn(async () => 0);
		const labDialog = vi.fn(async () => 1);
		expect(
			await showDesktopSessionRecoveryMessage(confirmation, { syntheticLab: false, showMessage, labDialog }),
		).toBe(0);
		expect(labDialog).not.toHaveBeenCalled();
		expect(
			await showDesktopSessionRecoveryMessage(confirmation, { syntheticLab: true, showMessage, labDialog }),
		).toBe(1);
		for (const invalid of [undefined, null, true, "1", -1, 2, { response: 1 }]) {
			expect(
				await showDesktopSessionRecoveryMessage(confirmation, {
					syntheticLab: true,
					showMessage,
					labDialog: async () => invalid,
				}),
			).toBe(0);
		}
		expect(
			await showDesktopSessionRecoveryMessage(confirmation, {
				syntheticLab: true,
				showMessage,
				labDialog: async () => {
					throw new Error("synthetic failure");
				},
			}),
		).toBe(0);
		labDialog.mockClear();
		await showDesktopSessionRecoveryMessage(
			{ message: "Session recovery remains blocked" },
			{ syntheticLab: true, showMessage, labDialog },
		);
		expect(labDialog).not.toHaveBeenCalled();
	});
	it("offers recovery only for an unconfirmed-custody startup failure", async () => {
		const surface = await startupSurface("startup_failed", "recovery_custody_unconfirmed").text();
		expect(surface).toContain('href="app://quarterdeck/__desktop/recover">Recover sessions…');
		expect(surface).toContain('href="app://quarterdeck/__desktop/retry"');
		expect(surface).toContain("background commands");
		expect(surface).toContain("restart the Mac");
		for (const kind of ["starting", "runtime_failed", "renderer_failed", "shutdown_failed"] as const) {
			expect(await startupSurface(kind, "recovery_custody_unconfirmed").text()).not.toContain("/__desktop/recover");
		}
		for (const code of ["startup_failed", "prior_processes_live", "recovery_evidence_unverifiable"] as const) {
			expect(await startupSurface("startup_failed", code).text()).not.toContain("/__desktop/recover");
		}
	});

	it("allowlists exact action URLs without accepting renderer-supplied arguments", () => {
		expect(desktopSurfaceAction("app://quarterdeck/__desktop/recover")).toBe("recover");
		for (const url of [
			"app://quarterdeck/__desktop/recover?confirm-stopped=1",
			"app://quarterdeck/__desktop/recover#confirmed",
			"app://quarterdeck/__desktop/%72ecover",
			"app://quarterdeck/__desktop/recover/",
			"app://other/__desktop/recover",
		]) {
			expect(desktopSurfaceAction(url)).toBeNull();
		}
	});

	it.each<Partial<DesktopSessionRecoveryContext>>([
		{ senderIsCurrent: false },
		{ surface: "product" },
		{ surface: "runtime_failed" },
		{ failureCode: "prior_processes_live" },
		{ failureCode: "recovery_evidence_unverifiable" },
		{ documentUrl: "app://quarterdeck/" },
		{ documentUrl: "app://quarterdeck/__desktop/startup" },
		{ documentUrl: "app://quarterdeck/__desktop/error?confirm=1" },
		{ busy: true },
		{ runtimeRunning: true },
	])("rejects an unavailable or untrusted surface: %j", async (change) => {
		const fixture = recovery();
		Object.assign(fixture.state, change);
		await recoverDesktopSessions(fixture.options);
		expect(fixture.options.showMessage).not.toHaveBeenCalled();
		expect(fixture.options.runHelper).not.toHaveBeenCalled();
		expect(fixture.options.retryRuntime).not.toHaveBeenCalled();
	});

	it("defaults to Cancel and never runs maintenance after cancellation", async () => {
		const fixture = recovery(0);
		await recoverDesktopSessions(fixture.options);
		expect(fixture.messages[0]).toMatchObject({
			defaultId: 0,
			cancelId: 0,
			buttons: ["Cancel", "Confirm Stopped and Recover"],
		});
		expect(fixture.messages[0]?.detail).toContain("Older runs cannot account for detached commands");
		expect(fixture.options.runHelper).not.toHaveBeenCalled();
		expect(fixture.options.retryRuntime).not.toHaveBeenCalled();
	});

	it("rechecks current authority after the explicit native confirmation", async () => {
		const fixture = recovery();
		fixture.options.showMessage.mockImplementation(async () => {
			fixture.state.runtimeRunning = true;
			return 1;
		});
		await recoverDesktopSessions(fixture.options);
		expect(fixture.options.runHelper).not.toHaveBeenCalled();
	});

	it("retries ordinary startup only after explicit confirmation and completed maintenance", async () => {
		const fixture = recovery();
		await recoverDesktopSessions(fixture.options);
		expect(fixture.options.runHelper).toHaveBeenCalledOnce();
		expect(fixture.options.retryRuntime).toHaveBeenCalledOnce();
		expect(fixture.options.showMessage.mock.invocationCallOrder[0]).toBeLessThan(
			fixture.options.runHelper.mock.invocationCallOrder[0] ?? 0,
		);
		expect(fixture.options.runHelper.mock.invocationCallOrder[0]).toBeLessThan(
			fixture.options.retryRuntime.mock.invocationCallOrder[0] ?? 0,
		);
	});

	it.each(["failed", "timed_out", "unavailable"] as const)("keeps startup blocked after %s", async (result) => {
		const fixture = recovery();
		await recoverDesktopSessions({ ...fixture.options, runHelper: async () => result });
		expect(fixture.options.retryRuntime).not.toHaveBeenCalled();
		expect(fixture.state.surface).toBe("startup_failed");
		expect(fixture.messages.at(-1)?.message).toBe("Session recovery remains blocked");
		expect(fixture.messages.at(-1)?.detail).toContain("Export Diagnostics");
		expect(fixture.messages.at(-1)?.detail).toContain("quarterdeck recover for the specific check result");
	});

	it("does not disclose helper errors or retry after the document loses authority", async () => {
		const fixture = recovery();
		await recoverDesktopSessions({
			...fixture.options,
			runHelper: async () => {
				throw new Error("private session contents");
			},
		});
		expect(JSON.stringify(fixture.messages)).not.toContain("private session contents");
		expect(fixture.options.retryRuntime).not.toHaveBeenCalled();
		await recoverDesktopSessions({
			...fixture.options,
			runHelper: async () => {
				fixture.state.senderIsCurrent = false;
				return "recovered";
			},
		});
		expect(fixture.options.retryRuntime).not.toHaveBeenCalled();
	});
});
