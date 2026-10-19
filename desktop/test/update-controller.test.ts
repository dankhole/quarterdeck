import { describe, expect, it, vi } from "vitest";
import type { DesktopInstallation } from "../../src/desktop-install/index.js";
import { DesktopUpdateCheckError } from "../../src/desktop-update/check.js";
import type { DesktopQuitPreflightResponse } from "../../src/shared/desktop-bridge-contract.js";
import { NpmUpdatePreparationError } from "../src/npm-update-runner.js";
import { DesktopQuitCoordinator, type DesktopQuitOptions } from "../src/quit-coordinator.js";
import { DesktopUpdateController, type DesktopUpdateControllerOptions } from "../src/update-controller.js";

function deferred<T>() {
	let resolve!: (value: T) => void;
	let reject!: (reason: unknown) => void;
	const promise = new Promise<T>((done, fail) => {
		resolve = done;
		reject = fail;
	});
	return { promise, resolve, reject };
}

function installation(kind: "npm" | "link" = "npm"): DesktopInstallation {
	return {
		appPath: "/synthetic/Applications/Quarterdeck.app",
		version: "0.12.8",
		arch: "arm64",
		source: "release",
		installId: "install",
		buildId: "build",
		appAsarSha256: "a".repeat(64),
		receiptPath: "/synthetic/receipt.json",
		cleanupPending: false,
		owner: {
			kind,
			packageRoot: "/synthetic/Node's Space/lib/node_modules/quarterdeck",
			packageSlot: "/synthetic/Node's Space/lib/node_modules/quarterdeck",
			prefix: "/synthetic/Node's Space",
			identity: {
				schemaVersion: 1,
				version: "0.12.8",
				buildId: "build",
				sourceSha: "a".repeat(40),
				sourceDirty: false,
			},
		},
	};
}

function fixture(overrides: Partial<DesktopUpdateControllerOptions> = {}) {
	const installed = installation();
	const events: string[] = [];
	const runner = {
		launch: vi.fn(async () => {
			events.push("ready");
		}),
		authorize: vi.fn(async () => {
			events.push("authorize");
		}),
		commit: vi.fn(() => {
			events.push("commit");
		}),
		cancel: vi.fn(async () => {
			events.push("cancel");
		}),
	};
	const options: DesktopUpdateControllerOptions = {
		installation: installed,
		installedVersion: installed.version,
		synthetic: false,
		dialogs: { message: vi.fn(async () => 0) },
		clipboard: { writeText: vi.fn() },
		openReleaseNotes: vi.fn(async () => undefined),
		getEnvironment: () => ({ PATH: "/synthetic/external/bin" }),
		canTransition: () => true,
		requestQuit: vi.fn<DesktopUpdateControllerOptions["requestQuit"]>(async (authorize) => {
			events.push("quit-preflight");
			await authorize();
			return { kind: "clean" };
		}),
		quit: vi.fn(() => {
			events.push("app-quit");
		}),
		check: vi.fn<NonNullable<DesktopUpdateControllerOptions["check"]>>(async () => ({
			channel: "latest",
			availableVersion: "0.12.9",
		})),
		validateInstallation: vi.fn(async () => installed),
		prepare: vi.fn(async () => runner),
		...overrides,
	};
	return { controller: new DesktopUpdateController(options), options, runner, events };
}

const READY: DesktopQuitPreflightResponse = {
	requestId: "request",
	runtimeGeneration: "generation",
	decision: "ready",
	status: { dirtyEditorCount: 0, activeSessionCount: 0, needsInputSessionCount: 0, runtimeConnected: true },
};
function quitFixture(overrides: Partial<DesktopQuitOptions> = {}) {
	const options: DesktopQuitOptions = {
		needsFrontendPreflight: () => true,
		cleanupState: () => "running",
		preflight: vi.fn(async () => READY),
		isSealValid: () => true,
		releasePreflight: vi.fn(),
		getSummary: vi.fn<DesktopQuitOptions["getSummary"]>(async () => ({
			method: "get-quit-summary",
			owned: true,
			liveProcessCount: 2,
			pendingLaunches: false,
		})),
		stop: vi.fn<DesktopQuitOptions["stop"]>(async () => ({
			status: "clean",
			safeToExit: true,
			safeToReleaseOwnership: true,
		})),
		confirmSessions: vi.fn(async () => true),
		confirmUnconfirmedExit: vi.fn(async () => true),
		inform: vi.fn(async () => undefined),
		onStopping: vi.fn(),
		...overrides,
	};
	return { coordinator: new DesktopQuitCoordinator(options), options };
}

describe("native npm update controller", () => {
	it("checks once at startup and publishes availability without opening a dialog", async () => {
		const pending = deferred<{ channel: "latest"; availableVersion: string | null }>();
		const { controller, options } = fixture({ check: vi.fn(() => pending.promise) });
		const observed = vi.fn();
		controller.subscribe(observed);
		controller.start();
		controller.start();
		expect(options.check).toHaveBeenCalledOnce();
		expect(controller.getSnapshot().phase).toBe("checking");
		pending.resolve({ channel: "latest", availableVersion: "0.12.9" });
		await vi.waitFor(() => expect(controller.getSnapshot().phase).toBe("available"));
		expect(controller.getSnapshot()).toEqual({
			phase: "available",
			installedVersion: "0.12.8",
			availableVersion: "0.12.9",
			channel: "latest",
		});
		expect(options.dialogs.message).not.toHaveBeenCalled();
		expect(observed).toHaveBeenCalledTimes(2);
	});

	it("deduplicates an explicit check against startup and presents its result once", async () => {
		const pending = deferred<{ channel: "latest"; availableVersion: null }>();
		const { controller, options } = fixture({ check: vi.fn(() => pending.promise) });
		controller.start();
		const first = controller.request("check");
		const second = controller.request("check");
		expect(first).toBe(second);
		pending.resolve({ channel: "latest", availableVersion: null });
		await first;
		expect(options.check).toHaveBeenCalledOnce();
		expect(options.dialogs.message).toHaveBeenCalledExactlyOnceWith(
			expect.objectContaining({ message: "Quarterdeck is up to date" }),
		);
	});

	it("keeps startup failures quiet, but explains a manual failure", async () => {
		const { controller, options } = fixture({
			check: vi.fn(async () => {
				throw new Error("private transport text");
			}),
		});
		controller.start();
		await vi.waitFor(() => expect(controller.getSnapshot().phase).toBe("failed"));
		expect(options.dialogs.message).not.toHaveBeenCalled();
		await controller.request("check");
		expect(options.dialogs.message).toHaveBeenCalledExactlyOnceWith(
			expect.objectContaining({ message: "Could not check for updates" }),
		);
		expect(JSON.stringify(vi.mocked(options.dialogs.message).mock.calls)).not.toContain("private transport text");
	});

	it("explains a typed registry check failure without adding it to the snapshot", async () => {
		const error = new DesktopUpdateCheckError("invalid_registry_response");
		const { controller, options } = fixture({
			check: vi.fn(async () => {
				throw error;
			}),
		});
		await controller.request("check");
		expect(options.dialogs.message).toHaveBeenCalledExactlyOnceWith(
			expect.objectContaining({ detail: error.message }),
		);
		expect(controller.getSnapshot()).toEqual({
			phase: "failed",
			installedVersion: "0.12.8",
			availableVersion: null,
			channel: null,
		});
	});

	it("revokes an available target as soon as refresh starts and never authorizes it after failure", async () => {
		const later = deferred<{ channel: "latest"; availableVersion: string | null }>();
		const check = vi
			.fn<NonNullable<DesktopUpdateControllerOptions["check"]>>()
			.mockResolvedValueOnce({ channel: "latest", availableVersion: "0.12.9" })
			.mockImplementationOnce(() => later.promise);
		const { controller, options } = fixture({ check });
		await controller.request("check");
		const checking = controller.request("check");
		expect(controller.getSnapshot()).toMatchObject({ phase: "checking", availableVersion: null });
		later.reject(new Error("offline"));
		await checking;
		await controller.request("details");
		expect(controller.getSnapshot()).toMatchObject({ phase: "failed", availableVersion: null });
		expect(options.prepare).not.toHaveBeenCalled();
	});

	it("invalidates late registry completion and subscription delivery on disposal", async () => {
		const pending = deferred<{ channel: "latest"; availableVersion: string }>();
		const { controller, options } = fixture({ check: vi.fn(() => pending.promise) });
		const listener = vi.fn();
		const unsubscribe = controller.subscribe(listener);
		controller.start();
		unsubscribe();
		controller.dispose();
		pending.resolve({ channel: "latest", availableVersion: "0.12.9" });
		await Promise.resolve();
		await Promise.resolve();
		expect(controller.getSnapshot().phase).toBe("checking");
		expect(listener).toHaveBeenCalledOnce();
		expect(options.dialogs.message).not.toHaveBeenCalled();
	});

	it("uses only linked-checkout guidance without checking production metadata", async () => {
		const { controller, options } = fixture({
			installation: installation("link"),
			dialogs: { message: vi.fn(async () => 1) },
		});
		controller.start();
		await controller.request("check");
		expect(controller.getSnapshot().phase).toBe("disabled");
		expect(options.check).not.toHaveBeenCalled();
		expect(options.prepare).not.toHaveBeenCalled();
		expect(options.clipboard.writeText).toHaveBeenCalledWith(expect.stringContaining("npm run link"));
	});

	it.each([{ synthetic: true }, { installation: null }])(
		"suppresses synthetic and unmanaged production actions: %j",
		async (overrides) => {
			const { controller, options } = fixture(overrides);
			controller.start();
			await controller.request("check");
			await controller.request("details");
			expect(controller.getSnapshot().phase).toBe("disabled");
			expect(options.check).not.toHaveBeenCalled();
			expect(options.dialogs.message).not.toHaveBeenCalled();
			expect(options.prepare).not.toHaveBeenCalled();
		},
	);

	it("opens fixed release notes through its native callback without preparing npm", async () => {
		const { controller, options } = fixture({ dialogs: { message: vi.fn(async () => 1) } });
		await controller.request("check");
		expect(options.openReleaseNotes).toHaveBeenCalledExactlyOnceWith();
		expect(options.prepare).not.toHaveBeenCalled();
	});

	it("serializes repeated clicks through details, readiness, clean quit, authorization and app exit", async () => {
		const answer = deferred<number>();
		const { controller, options, runner, events } = fixture({ dialogs: { message: vi.fn(() => answer.promise) } });
		controller.start();
		await vi.waitFor(() => expect(controller.getSnapshot().phase).toBe("available"));
		const first = controller.request("details");
		expect(controller.isBusy()).toBe(true);
		const second = controller.request("details");
		expect(second).toBe(first);
		answer.resolve(2);
		await first;
		expect(options.validateInstallation).toHaveBeenCalledExactlyOnceWith({
			appPath: installation().appPath,
			version: "0.12.8",
		});
		expect(options.prepare).toHaveBeenCalledExactlyOnceWith({
			installation: installation(),
			targetVersion: "0.12.9",
			environment: { PATH: "/synthetic/external/bin" },
		});
		expect(events).toEqual(["ready", "quit-preflight", "authorize", "commit", "app-quit"]);
		expect(runner.cancel).not.toHaveBeenCalled();
		controller.dispose();
		expect(runner.cancel).not.toHaveBeenCalled();
	});

	it.each(["dirty", "sessions", "unconfirmed"] as const)(
		"cancels the prepared runner after %s shutdown veto without authorizing npm",
		async (veto) => {
			const quitting = quitFixture({
				...(veto === "dirty"
					? {
							preflight: vi.fn<DesktopQuitOptions["preflight"]>(async () => ({
								...READY,
								decision: "blocked",
								status: { ...READY.status, dirtyEditorCount: 1 },
							})),
						}
					: {}),
				...(veto === "sessions" ? { confirmSessions: vi.fn(async () => false) } : {}),
				...(veto === "unconfirmed" ? { cleanupState: () => "unconfirmed" } : {}),
			});
			const { controller, runner, options } = fixture({
				dialogs: { message: vi.fn(async () => 2) },
				requestQuit: (authorize) => quitting.coordinator.request("update", authorize),
			});
			await controller.request("check");
			expect(quitting.options.stop).not.toHaveBeenCalled();
			expect(quitting.options.confirmUnconfirmedExit).not.toHaveBeenCalled();
			expect(runner.launch).toHaveBeenCalledOnce();
			expect(runner.authorize).not.toHaveBeenCalled();
			expect(runner.cancel).toHaveBeenCalledOnce();
			expect(options.quit).not.toHaveBeenCalled();
			expect(controller.isBusy()).toBe(false);
			expect(controller.getSnapshot().phase).toBe("available");
		},
	);

	it("cancels after a post-clean authorization error and retains a usable native controller", async () => {
		const quitting = quitFixture();
		const { controller, runner, options } = fixture({
			dialogs: { message: vi.fn(async () => 2) },
			requestQuit: (authorize) => quitting.coordinator.request("update", authorize),
		});
		runner.authorize.mockRejectedValueOnce(new Error("authorization refused"));
		await controller.request("check");
		expect(quitting.options.stop).toHaveBeenCalledOnce();
		expect(runner.cancel).toHaveBeenCalledOnce();
		expect(options.quit).not.toHaveBeenCalled();
		expect(controller.isBusy()).toBe(false);
		expect(controller.getSnapshot().phase).toBe("available");
		await controller.request("check");
		expect(options.check).toHaveBeenCalledTimes(2);
	});

	it("revokes an acknowledged authorization if the final draft seal is lost", async () => {
		let dirty = false;
		const quitting = quitFixture({
			isSealValid: () => !dirty,
			preflight: async () =>
				dirty ? { ...READY, decision: "blocked", status: { ...READY.status, dirtyEditorCount: 1 } } : READY,
		});
		const { controller, runner, options } = fixture({
			dialogs: { message: vi.fn(async () => 2) },
			requestQuit: (authorize) => quitting.coordinator.request("update", authorize),
		});
		runner.authorize.mockImplementationOnce(async () => {
			dirty = true;
		});
		await controller.request("check");
		expect(quitting.options.stop).toHaveBeenCalledOnce();
		expect(runner.authorize).toHaveBeenCalledOnce();
		expect(runner.cancel).toHaveBeenCalledOnce();
		expect(options.quit).not.toHaveBeenCalled();
		expect(controller.isBusy()).toBe(false);
	});

	it("commits and requests app exit in one synchronous stack after the final seal", async () => {
		const { controller, runner, events } = fixture({ dialogs: { message: vi.fn(async () => 2) } });
		runner.commit.mockImplementationOnce(() => {
			events.push("commit");
			queueMicrotask(() => events.push("later-microtask"));
		});
		await controller.request("check");
		expect(events).toEqual(["ready", "quit-preflight", "authorize", "commit", "app-quit", "later-microtask"]);
		expect(runner.cancel).not.toHaveBeenCalled();
	});

	it("cancels an inert runner and releases the clean quit lease if final commit throws", async () => {
		const quitting = quitFixture();
		const recover = vi.fn(() => quitting.options.releasePreflight());
		const { controller, runner, options } = fixture({
			dialogs: { message: vi.fn(async () => 2) },
			requestQuit: (authorize) => quitting.coordinator.request("update", authorize),
			onCancelledQuit: recover,
		});
		runner.commit.mockImplementationOnce(() => {
			throw new Error("commit refused");
		});
		await controller.request("check");
		expect(quitting.options.stop).toHaveBeenCalledOnce();
		expect(runner.authorize).toHaveBeenCalledOnce();
		expect(runner.cancel).toHaveBeenCalledOnce();
		expect(recover).toHaveBeenCalledOnce();
		expect(quitting.options.releasePreflight).toHaveBeenCalledOnce();
		expect(options.quit).not.toHaveBeenCalled();
		expect(controller.getSnapshot()).toMatchObject({ phase: "failed", availableVersion: null });
		expect(controller.isBusy()).toBe(false);
	});

	it("retains the committed quit transaction if requesting app exit unexpectedly throws", async () => {
		const recover = vi.fn();
		const { controller, runner, options } = fixture({
			dialogs: { message: vi.fn(async () => 2) },
			quit: vi.fn(() => {
				throw new Error("app quit threw");
			}),
			onCancelledQuit: recover,
		});
		await controller.request("check");
		expect(runner.commit).toHaveBeenCalledOnce();
		expect(runner.cancel).not.toHaveBeenCalled();
		expect(recover).not.toHaveBeenCalled();
		expect(options.dialogs.message).toHaveBeenCalledOnce();
		expect(controller.getSnapshot().phase).toBe("quitting");
		expect(controller.isBusy()).toBe(true);
		await controller.request("check");
		expect(options.check).toHaveBeenCalledOnce();
		controller.dispose();
		expect(runner.cancel).not.toHaveBeenCalled();
	});

	it("requires handoff readiness before starting shutdown and cancels a failed launch", async () => {
		const ready = deferred<void>();
		const { controller, runner, options } = fixture({ dialogs: { message: vi.fn(async () => 2) } });
		runner.launch.mockImplementationOnce(() => ready.promise);
		const updating = controller.request("check");
		await vi.waitFor(() => expect(runner.launch).toHaveBeenCalledOnce());
		expect(controller.getSnapshot().phase).toBe("preparing");
		expect(options.requestQuit).not.toHaveBeenCalled();
		ready.reject(new Error("not ready"));
		await updating;
		expect(runner.cancel).toHaveBeenCalledOnce();
		expect(options.requestQuit).not.toHaveBeenCalled();
		expect(options.quit).not.toHaveBeenCalled();
		expect(controller.isBusy()).toBe(false);
	});

	it("refuses a forced outcome even if a caller incorrectly returns one", async () => {
		const { controller, runner, options } = fixture({
			dialogs: { message: vi.fn(async () => 2) },
			requestQuit: async () => ({ kind: "forced", cleanup: "unconfirmed" }),
		});
		await controller.request("check");
		expect(runner.authorize).not.toHaveBeenCalled();
		expect(runner.cancel).toHaveBeenCalledOnce();
		expect(options.quit).not.toHaveBeenCalled();
	});

	it("shows exact manual guidance for toolchain failure and keeps the app open", async () => {
		const dialogs = { message: vi.fn().mockResolvedValueOnce(2).mockResolvedValueOnce(1) };
		const { controller, options } = fixture({
			dialogs,
			prepare: vi.fn(async () => {
				throw new NpmUpdatePreparationError("External npm is missing.", installation(), "0.12.9");
			}),
		});
		await controller.request("check");
		expect(options.requestQuit).not.toHaveBeenCalled();
		expect(options.quit).not.toHaveBeenCalled();
		expect(controller.isBusy()).toBe(false);
		expect(controller.getSnapshot()).toMatchObject({ phase: "failed", availableVersion: null });
		expect(dialogs.message).toHaveBeenLastCalledWith(
			expect.objectContaining({ detail: expect.stringContaining("External npm is missing.") }),
		);
		expect(options.clipboard.writeText).toHaveBeenCalledWith(
			"QUARTERDECK_INSTALL_MODE=desktop npm install --global --prefix '/synthetic/Node'\"'\"'s Space' quarterdeck@0.12.9 --registry https://registry.npmjs.org --foreground-scripts",
		);
	});

	it("revalidates the owning slot before preparing a handoff", async () => {
		const changed = installation();
		changed.owner = { ...changed.owner, prefix: "/synthetic/changed" };
		const { controller, options } = fixture({
			dialogs: { message: vi.fn(async () => 2) },
			validateInstallation: vi.fn(async () => changed),
		});
		await controller.request("check");
		expect(options.prepare).not.toHaveBeenCalled();
		expect(options.requestQuit).not.toHaveBeenCalled();
		expect(controller.getSnapshot().phase).toBe("failed");
	});

	it("cancels a prepared handoff returned after disposal without shutdown", async () => {
		const pending = deferred<Awaited<ReturnType<NonNullable<DesktopUpdateControllerOptions["prepare"]>>>>();
		const { controller, runner, options } = fixture({
			dialogs: { message: vi.fn(async () => 2) },
			prepare: vi.fn(() => pending.promise),
		});
		const request = controller.request("check");
		await vi.waitFor(() => expect(options.prepare).toHaveBeenCalledOnce());
		controller.dispose();
		pending.resolve(runner);
		await request;
		expect(runner.cancel).toHaveBeenCalledOnce();
		expect(runner.launch).not.toHaveBeenCalled();
		expect(options.requestQuit).not.toHaveBeenCalled();
	});
});
