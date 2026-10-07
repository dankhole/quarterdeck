import { describe, expect, it, vi } from "vitest";
import type { DesktopQuitPreflightResponse } from "../../src/shared/desktop-bridge-contract.js";
import { DesktopQuitCoordinator, type DesktopQuitOptions } from "../src/quit-coordinator.js";

const READY: DesktopQuitPreflightResponse = {
	requestId: "request",
	runtimeGeneration: "generation",
	decision: "ready",
	status: { dirtyEditorCount: 0, activeSessionCount: 0, needsInputSessionCount: 0, runtimeConnected: true },
};
const DIRTY: DesktopQuitPreflightResponse = {
	...READY,
	decision: "blocked",
	status: { ...READY.status, dirtyEditorCount: 1 },
};

function fixture(overrides: Partial<DesktopQuitOptions> = {}) {
	const options: DesktopQuitOptions = {
		needsFrontendPreflight: () => true,
		cleanupState: () => "running",
		preflight: vi.fn(async () => READY),
		isSealValid: () => true,
		releasePreflight: vi.fn(),
		getSummary: vi.fn(
			async () =>
				({ method: "get-quit-summary", owned: true, liveProcessCount: 3, pendingLaunches: false }) as const,
		),
		stop: vi.fn(async () => ({ status: "clean", safeToExit: true, safeToReleaseOwnership: true }) as const),
		confirmSessions: vi.fn(async () => true),
		confirmUnconfirmedExit: vi.fn(async () => true),
		canForceExit: () => true,
		inform: vi.fn(async () => undefined),
		onStopping: vi.fn(),
		...overrides,
	};
	return { owner: new DesktopQuitCoordinator(options), options };
}

describe("native quit and update lease", () => {
	it("serializes requests and lets normal Quit take over an update without duplicating shutdown", async () => {
		const { owner, options } = fixture();
		expect(owner.isPending()).toBe(false);
		const update = owner.request("update");
		expect(owner.isPending()).toBe(true);
		const quit = owner.request("quit");
		expect(quit).toBe(update);
		expect(owner.isNormalQuitPending()).toBe(true);
		expect(await update).toEqual({ kind: "clean" });
		expect(owner.isPending()).toBe(false);
		expect(options.stop).toHaveBeenCalledOnce();
		expect(options.preflight).toHaveBeenNthCalledWith(2, "update", true);
	});
	it("keeps dirty-editor vetoes authoritative before stopping any session", async () => {
		const { owner, options } = fixture({ preflight: async () => DIRTY });
		expect(await owner.request("quit")).toEqual({ kind: "cancelled" });
		expect(options.stop).not.toHaveBeenCalled();
		expect(options.releasePreflight).toHaveBeenCalledOnce();
	});
	it("rechecks drafts created while a native session-confirmation dialog was open", async () => {
		let dirty = false;
		const { owner, options } = fixture({
			preflight: async () => (dirty ? DIRTY : READY),
			confirmSessions: async () => {
				dirty = true;
				return true;
			},
		});
		expect(await owner.request("quit")).toEqual({ kind: "cancelled" });
		expect(options.stop).not.toHaveBeenCalled();
	});
	it("requires a fresh sealed draft check after Quit Anyway confirmation", async () => {
		let dirty = false;
		const { owner, options } = fixture({
			cleanupState: () => "unconfirmed",
			preflight: async () => (dirty ? DIRTY : { ...READY, status: { ...READY.status, runtimeConnected: false } }),
			confirmUnconfirmedExit: async () => {
				dirty = true;
				return true;
			},
		});
		expect(await owner.request("quit")).toEqual({ kind: "cancelled" });
		expect(options.stop).not.toHaveBeenCalled();
	});
	it("labels an explicit normal force exit unconfirmed and never offers it to updates", async () => {
		const normal = fixture({ cleanupState: () => "unconfirmed" });
		expect(await normal.owner.request("quit")).toEqual({ kind: "forced", cleanup: "unconfirmed" });
		const update = fixture({ cleanupState: () => "unconfirmed" });
		expect(await update.owner.request("update")).toEqual({ kind: "cancelled" });
		expect(update.options.confirmUnconfirmedExit).not.toHaveBeenCalled();
	});
	it("does not interrupt an attached CLI owner's sessions", async () => {
		const { owner, options } = fixture({
			getSummary: async () => ({
				method: "get-quit-summary",
				owned: false,
				liveProcessCount: 0,
				pendingLaunches: false,
			}),
		});
		expect(await owner.request("quit")).toEqual({ kind: "clean" });
		expect(options.confirmSessions).not.toHaveBeenCalled();
	});
	it("cannot commit an update after the renderer seal expired during shutdown", async () => {
		let checks = 0;
		const { owner } = fixture({
			isSealValid: () => ++checks === 1,
			preflight: async (reason, seal) => (reason === "update" && seal && checks > 0 ? null : READY),
		});
		expect(await owner.request("update")).toEqual({ kind: "cancelled" });
	});
	it("waits for bounded startup-owned work before declaring a startup Quit clean", async () => {
		let finishPreparation: () => void = () => undefined;
		const preparation = new Promise<void>((resolve) => {
			finishPreparation = resolve;
		});
		let stopped = false;
		const { owner } = fixture({
			needsFrontendPreflight: () => false,
			cleanupState: () => "not_started",
			stop: async () => {
				await preparation;
				stopped = true;
				return { status: "clean", safeToExit: true, safeToReleaseOwnership: true };
			},
		});
		const quitting = owner.request("quit");
		await Promise.resolve();
		expect(stopped).toBe(false);
		finishPreparation();
		expect(await quitting).toEqual({ kind: "clean" });
	});
	it("blocks forced normal Quit when a downloaded update may apply on relaunch", async () => {
		const { owner, options } = fixture({ cleanupState: () => "unconfirmed", canForceExit: () => false });
		expect(await owner.request("quit")).toEqual({ kind: "cancelled" });
		expect(options.confirmUnconfirmedExit).not.toHaveBeenCalled();
		expect(options.inform).toHaveBeenCalledExactlyOnceWith("shutdown_incomplete");
	});
	it("explains an update veto after final evidence flushing but quietly respects declined Quit Anyway", async () => {
		let pending = false;
		const late = fixture({
			cleanupState: () => "unconfirmed",
			canForceExit: () => !pending,
			finalize: async () => {
				pending = true;
			},
		});
		expect(await late.owner.request("quit")).toEqual({ kind: "cancelled" });
		expect(late.options.inform).toHaveBeenCalledExactlyOnceWith("shutdown_incomplete");
		const declined = fixture({ cleanupState: () => "unconfirmed", confirmUnconfirmedExit: async () => false });
		expect(await declined.owner.request("quit")).toEqual({ kind: "cancelled" });
		expect(declined.options.inform).not.toHaveBeenCalled();
	});
	it("still cancels and releases the seal when the final pending-update explanation fails", async () => {
		let pending = false;
		const { owner, options } = fixture({
			cleanupState: () => "unconfirmed",
			canForceExit: () => !pending,
			finalize: async () => {
				pending = true;
			},
			inform: vi.fn(async () => {
				throw new Error("presentation unavailable");
			}),
		});
		expect(await owner.request("quit")).toEqual({ kind: "cancelled" });
		expect(options.releasePreflight).toHaveBeenCalledOnce();
		expect(owner.isPending()).toBe(false);
	});
	it.each(["already_unconfirmed", "failed_stop"])(
		"vetoes forced Quit if an update arrives during the last async seal (%s)",
		async (mode) => {
			let pendingUpdate = false;
			let cleanup: "running" | "unconfirmed" = mode === "already_unconfirmed" ? "unconfirmed" : "running";
			let seals = 0;
			const { owner } = fixture({
				cleanupState: () => cleanup,
				canForceExit: () => !pendingUpdate,
				stop: async () => {
					cleanup = "unconfirmed";
					return {
						status: "incomplete",
						safeToExit: false,
						safeToReleaseOwnership: false,
						reasons: ["processes_unconfirmed"],
					};
				},
				preflight: async (_reason, seal) => {
					if (seal && ++seals === (mode === "already_unconfirmed" ? 1 : 2)) {
						await Promise.resolve();
						pendingUpdate = true;
					}
					return READY;
				},
			});
			expect(await owner.request("quit")).toEqual({ kind: "cancelled" });
		},
	);
	it("retains a verified clean receipt for disconnected update retry and still protects drafts", async () => {
		const offline = { ...READY, status: { ...READY.status, runtimeConnected: false } };
		const clean = fixture({ cleanupState: () => "clean", preflight: async () => offline });
		expect(await clean.owner.request("update")).toEqual({ kind: "clean" });
		const dirty = fixture({ cleanupState: () => "clean", preflight: async () => DIRTY });
		expect(await dirty.owner.request("update")).toEqual({ kind: "cancelled" });
		const uncertain = fixture({ cleanupState: () => "unconfirmed", preflight: async () => offline });
		expect(await uncertain.owner.request("update")).toEqual({ kind: "cancelled" });
	});
	it("renews the renderer seal if final evidence flushing outlasts its deadline", async () => {
		let valid = true;
		const { owner, options } = fixture({
			isSealValid: () => valid,
			finalize: async () => {
				valid = false;
			},
			preflight: async (_reason, seal) => (seal && !valid ? DIRTY : READY),
		});
		expect(await owner.request("quit")).toEqual({ kind: "cancelled" });
		expect(options.releasePreflight).toHaveBeenCalledOnce();
	});
});
