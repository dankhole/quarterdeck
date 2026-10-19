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
		inform: vi.fn(async () => undefined),
		onStopping: vi.fn(),
		...overrides,
	};
	return { owner: new DesktopQuitCoordinator(options), options };
}

describe("native quit and runtime restart lease", () => {
	it("never offers unconfirmed cleanup to an update or calls its commit", async () => {
		const { owner, options } = fixture({ cleanupState: () => "unconfirmed" });
		const commit = vi.fn(async () => undefined);
		expect(await owner.request("update", commit)).toEqual({ kind: "cancelled" });
		expect(options.confirmUnconfirmedExit).not.toHaveBeenCalled();
		expect(commit).not.toHaveBeenCalled();
	});
	it("seals drafts after cleanup/evidence before committing an update", async () => {
		const events: string[] = [];
		const { owner } = fixture({
			preflight: async (_reason, seal) => {
				events.push(seal ? "seal" : "preflight");
				return READY;
			},
			stop: async () => {
				events.push("stop");
				return { status: "clean", safeToExit: true, safeToReleaseOwnership: true };
			},
			finalize: async () => {
				events.push("flush");
			},
		});
		expect(
			await owner.request("update", async () => {
				events.push("authorize");
			}),
		).toEqual({ kind: "clean" });
		expect(events).toEqual(["preflight", "seal", "stop", "flush", "seal", "authorize"]);
	});
	it("keeps post-clean draft protection usable after the runtime disconnects", async () => {
		let connected = true;
		const { owner, options } = fixture({
			preflight: vi.fn<DesktopQuitOptions["preflight"]>(async (reason) => ({
				...READY,
				decision: reason === "update" && !connected ? "blocked" : "ready",
				status: { ...READY.status, runtimeConnected: connected },
			})),
			stop: async () => {
				connected = false;
				return { status: "clean", safeToExit: true, safeToReleaseOwnership: true };
			},
		});
		const commit = vi.fn(async () => undefined);
		expect(await owner.request("update", commit)).toEqual({ kind: "clean" });
		expect(options.preflight).toHaveBeenNthCalledWith(1, "update");
		expect(options.preflight).toHaveBeenLastCalledWith("quit", true);
		expect(commit).toHaveBeenCalledOnce();
	});
	it("refuses competing transitions while a clean update commit is pending", async () => {
		let commit: () => void = () => undefined;
		const authorization = new Promise<void>((resolve) => {
			commit = resolve;
		});
		const { owner } = fixture();
		const update = owner.request("update", () => authorization);
		await vi.waitFor(() => expect(owner.isPending()).toBe(true));
		expect(await owner.request("quit")).toEqual({ kind: "cancelled" });
		expect(await owner.request("restart")).toEqual({ kind: "cancelled" });
		expect(await owner.request("update")).toEqual({ kind: "cancelled" });
		expect(owner.isNormalQuitPending()).toBe(false);
		commit();
		expect(await update).toEqual({ kind: "clean" });
	});
	it("cancels an update if its draft seal cannot be renewed after authorization", async () => {
		let valid = true;
		const { owner, options } = fixture({
			isSealValid: () => valid,
			preflight: async () => (valid ? READY : DIRTY),
		});
		expect(
			await owner.request("update", async () => {
				valid = false;
			}),
		).toEqual({ kind: "cancelled" });
		expect(options.stop).toHaveBeenCalledOnce();
		expect(options.releasePreflight).toHaveBeenCalledOnce();
	});
	it("does not attach update authorization to an ordinary quit already in progress", async () => {
		const { owner } = fixture();
		const quitting = owner.request("quit");
		const commit = vi.fn(async () => undefined);
		expect(await owner.request("update", commit)).toEqual({ kind: "cancelled" });
		expect(await quitting).toEqual({ kind: "clean" });
		expect(commit).not.toHaveBeenCalled();
	});
	it("serializes runtime restart and Quit without duplicating shutdown", async () => {
		const { owner, options } = fixture();
		expect(owner.isPending()).toBe(false);
		const restart = owner.request("restart");
		expect(owner.isPending()).toBe(true);
		const quit = owner.request("quit");
		expect(quit).toBe(restart);
		expect(owner.isNormalQuitPending()).toBe(true);
		expect(await restart).toEqual({ kind: "clean" });
		expect(owner.isPending()).toBe(false);
		expect(options.stop).toHaveBeenCalledOnce();
		expect(options.preflight).toHaveBeenNthCalledWith(2, "restart", true);
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
	it("labels an explicit normal force exit unconfirmed and never offers it to restarts", async () => {
		const normal = fixture({ cleanupState: () => "unconfirmed" });
		expect(await normal.owner.request("quit")).toEqual({ kind: "forced", cleanup: "unconfirmed" });
		const restart = fixture({ cleanupState: () => "unconfirmed" });
		expect(await restart.owner.request("restart")).toEqual({ kind: "cancelled" });
		expect(restart.options.confirmUnconfirmedExit).not.toHaveBeenCalled();
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
	it("cannot restart after the renderer seal expired during shutdown", async () => {
		let checks = 0;
		const { owner } = fixture({
			isSealValid: () => ++checks === 1,
			preflight: async (reason, seal) => (reason === "restart" && seal && checks > 0 ? null : READY),
		});
		expect(await owner.request("restart")).toEqual({ kind: "cancelled" });
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
	it("retains a clean shutdown receipt while still protecting offline drafts", async () => {
		const offline = { ...READY, status: { ...READY.status, runtimeConnected: false } };
		const clean = fixture({ cleanupState: () => "clean", preflight: async () => offline });
		expect(await clean.owner.request("quit")).toEqual({ kind: "clean" });
		const dirty = fixture({ cleanupState: () => "clean", preflight: async () => DIRTY });
		expect(await dirty.owner.request("quit")).toEqual({ kind: "cancelled" });
		const uncertain = fixture({ cleanupState: () => "unconfirmed", preflight: async () => offline });
		expect(await uncertain.owner.request("restart")).toEqual({ kind: "cancelled" });
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
