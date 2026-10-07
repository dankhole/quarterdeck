import { EventEmitter } from "node:events";
import type { FeedURLOptions } from "electron";
import { describe, expect, it, vi } from "vitest";
import { type DesktopUpdateEligibility, DesktopUpdates, desktopUpdateEligibility } from "../src/desktop-updates.js";

class Updater extends EventEmitter {
	setFeedURL = vi.fn<(options: FeedURLOptions) => void>();
	checkForUpdates = vi.fn<() => void>();
	quitAndInstall = vi.fn<() => void>();
}

function deferred<T>() {
	let resolve: (value: T) => void = () => undefined;
	const promise = new Promise<T>((done) => {
		resolve = done;
	});
	return { promise, resolve };
}

function fixture(eligibility: DesktopUpdateEligibility = { enabled: true, arch: "arm64", version: "0.12.8" }) {
	const updater = new Updater();
	const preflightAndShutdown = vi.fn(async () => true);
	const showMessage = vi.fn(async () => undefined);
	const chooseDownloadedUpdate = vi.fn(async (): Promise<"later" | "restart"> => "later");
	const isNormalQuitPending = vi.fn(() => false);
	const onEvidence = vi.fn();
	const onRestartFailed = vi.fn<() => Promise<void>>(async () => undefined);
	const controller = new DesktopUpdates({
		updater,
		eligibility,
		preflightAndShutdown,
		showMessage,
		chooseDownloadedUpdate,
		isNormalQuitPending,
		onEvidence,
		onRestartFailed,
	});
	const download = async () => {
		await controller.checkForUpdates();
		updater.emit("update-available");
		updater.emit(
			"update-downloaded",
			{},
			"untrusted notes",
			"untrusted release",
			new Date(),
			"https://arbitrary.invalid/",
		);
		await Promise.resolve();
		await Promise.resolve();
	};
	return {
		updater,
		controller,
		preflightAndShutdown,
		showMessage,
		chooseDownloadedUpdate,
		isNormalQuitPending,
		onEvidence,
		onRestartFailed,
		download,
	};
}

describe("desktop release eligibility", () => {
	const signed = {
		isPackaged: true,
		synthetic: false,
		platform: "darwin" as const,
		arch: "arm64",
		version: "0.12.8",
		signed: true,
		hardened: true,
		productionFeedEnabled: true,
	};
	it("requires packaged verified signatures, hardened runtime, and explicit production feed enablement", () => {
		expect(desktopUpdateEligibility(signed)).toEqual({ enabled: true, arch: "arm64", version: "0.12.8" });
		for (const change of [{ isPackaged: false }, { signed: false }, { hardened: false }])
			expect(desktopUpdateEligibility({ ...signed, ...change })).toEqual({ enabled: false, reason: "unsigned" });
		expect(desktopUpdateEligibility({ ...signed, synthetic: true })).toEqual({ enabled: false, reason: "synthetic" });
		expect(desktopUpdateEligibility({ ...signed, productionFeedEnabled: false })).toEqual({
			enabled: false,
			reason: "production_feed_disabled",
		});
	});
	it("rejects preview versions, unsupported architectures/platforms, and URL-like versions", () => {
		for (const change of [
			{ version: "0.12.9-beta.1" },
			{ version: "../../arbitrary" },
			{ arch: "universal" },
			{ platform: "linux" as const },
		])
			expect(desktopUpdateEligibility({ ...signed, ...change })).toEqual({ enabled: false, reason: "unsupported" });
	});
	it("allows a signed validation base exclusively from production feed opt-in", () => {
		expect(
			desktopUpdateEligibility({
				...signed,
				productionFeedEnabled: false,
				validationFeedBase: "https://updates.example/validation",
			}),
		).toEqual({
			enabled: true,
			arch: "arm64",
			version: "0.12.8",
			validationFeedBase: "https://updates.example/validation/",
		});
		expect(desktopUpdateEligibility({ ...signed, validationFeedBase: "https://updates.example/" })).toEqual({
			enabled: false,
			reason: "unsupported",
		});
		expect(
			desktopUpdateEligibility({
				...signed,
				productionFeedEnabled: false,
				validationFeedBase: "http://updates.example/",
			}),
		).toEqual({ enabled: false, reason: "unsupported" });
	});
});

describe("macOS updater coordination", () => {
	it("constructs the architecture/version route only from main-verified signed validation policy", () => {
		const f = fixture({
			enabled: true,
			arch: "x64",
			version: "0.12.8",
			validationFeedBase: "https://updates.example/private/",
		});
		expect(f.updater.setFeedURL).toHaveBeenCalledExactlyOnceWith({
			url: "https://updates.example/private/darwin-x64/0.12.8",
		});
	});
	it.each(["synchronous", "microtask", "later"] as const)(
		"recovers an installer %s error after cleanup and permits a safe retry",
		async (timing) => {
			const f = fixture();
			await f.download();
			const order: string[] = [];
			f.preflightAndShutdown.mockImplementation(async () => {
				order.push("cleanup");
				return true;
			});
			f.onRestartFailed.mockImplementation(async () => {
				order.push("unseal");
			});
			f.updater.quitAndInstall.mockImplementationOnce(() => {
				order.push("install");
				if (timing === "synchronous") f.updater.emit("error", new Error("private installer data"));
				if (timing === "microtask")
					queueMicrotask(() => f.updater.emit("error", new Error("private installer data")));
			});
			const accepted = await f.controller.restartToUpdate();
			if (timing === "later") {
				expect(accepted).toBe(true);
				f.updater.emit("error", new Error("private installer data"));
			} else expect(accepted).toBe(false);
			await new Promise<void>((resolve) => setImmediate(resolve));
			expect(f.controller.snapshot()).toEqual({ phase: "downloaded", pending: true, reason: "restart_failed" });
			expect(order).toEqual(["cleanup", "install", "unseal"]);
			expect(f.onRestartFailed).toHaveBeenCalledTimes(1);
			expect(JSON.stringify(f.onEvidence.mock.calls)).not.toContain("private installer data");
			expect(f.showMessage).toHaveBeenCalledWith(
				expect.objectContaining({ message: "The update could not restart Quarterdeck" }),
			);
			expect(await f.controller.restartToUpdate()).toBe(true);
			expect(f.preflightAndShutdown).toHaveBeenCalledTimes(2);
		},
	);
	it("blocks repeated install attempts until installer recovery completes, and fails closed if recovery fails", async () => {
		const f = fixture();
		await f.download();
		await f.controller.restartToUpdate();
		const recovery = deferred<void>();
		f.onRestartFailed.mockImplementation(() => recovery.promise);
		f.updater.emit("error");
		await Promise.resolve();
		expect(await f.controller.restartToUpdate()).toBe(false);
		f.updater.emit("error");
		expect(f.onRestartFailed).toHaveBeenCalledTimes(1);
		recovery.resolve();
		await new Promise<void>((resolve) => setImmediate(resolve));
		f.onRestartFailed.mockRejectedValue(new Error("private recovery failure"));
		f.updater.quitAndInstall.mockImplementationOnce(() => f.updater.emit("error"));
		expect(await f.controller.restartToUpdate()).toBe(false);
		expect(await f.controller.restartToUpdate()).toBe(false);
		expect(f.updater.quitAndInstall).toHaveBeenCalledTimes(2);
	});
	it("does not initialize, check, or install an unsigned lab build", async () => {
		const f = fixture({ enabled: false, reason: "synthetic" });
		await f.controller.checkForUpdates();
		expect(f.showMessage).toHaveBeenCalledWith(
			expect.objectContaining({ message: "Updates are unavailable for this build" }),
		);
		expect(f.updater.setFeedURL).not.toHaveBeenCalled();
		expect(f.updater.checkForUpdates).not.toHaveBeenCalled();
		expect(await f.controller.restartToUpdate()).toBe(false);
		expect(f.updater.quitAndInstall).not.toHaveBeenCalled();
	});
	it("pins the architecture feed and prevents duplicate downloads", async () => {
		const f = fixture();
		expect(f.updater.setFeedURL).toHaveBeenCalledWith({
			url: "https://update.electronjs.org/dankhole/quarterdeck/darwin-arm64/0.12.8",
		});
		await f.controller.checkForUpdates();
		await f.controller.checkForUpdates();
		f.updater.emit("update-available");
		await f.controller.checkForUpdates();
		expect(f.controller.snapshot().phase).toBe("downloading");
		expect(f.updater.checkForUpdates).toHaveBeenCalledTimes(1);
	});
	it("shows no-update and offline outcomes without recording untrusted error content", async () => {
		const f = fixture();
		await f.controller.checkForUpdates();
		f.updater.emit("update-not-available");
		expect(f.controller.snapshot().phase).toBe("idle");
		expect(f.showMessage).toHaveBeenCalledWith(expect.objectContaining({ message: "Quarterdeck is up to date" }));
		await f.controller.checkForUpdates();
		f.updater.emit("error", new Error("credential and arbitrary feed content"));
		expect(f.controller.snapshot()).toEqual({ phase: "error", pending: false, reason: "update_failed" });
		expect(JSON.stringify(f.onEvidence.mock.calls)).not.toContain("credential");
		await f.controller.checkForUpdates();
		expect(f.updater.checkForUpdates).toHaveBeenCalledTimes(3);
	});
	it("Later retains the pending update and repeated download events do not reopen dialogs", async () => {
		const f = fixture();
		await f.download();
		f.updater.emit("update-downloaded");
		expect(f.controller.snapshot()).toEqual({ phase: "downloaded", pending: true });
		expect(f.chooseDownloadedUpdate).toHaveBeenCalledTimes(1);
		expect(f.chooseDownloadedUpdate).toHaveBeenCalledWith(
			expect.objectContaining({ detail: expect.stringContaining("next safe quit and relaunch") }),
		);
		expect(f.preflightAndShutdown).not.toHaveBeenCalled();
		expect(f.updater.quitAndInstall).not.toHaveBeenCalled();
	});
	it("awaits actual successful cleanup and installs only once", async () => {
		const f = fixture();
		await f.download();
		const shutdown = deferred<boolean>();
		f.preflightAndShutdown.mockImplementation(() => shutdown.promise);
		const first = f.controller.restartToUpdate();
		const duplicate = f.controller.restartToUpdate();
		expect(first).toBe(duplicate);
		await Promise.resolve();
		expect(f.updater.quitAndInstall).not.toHaveBeenCalled();
		shutdown.resolve(true);
		expect(await first).toBe(true);
		expect(f.preflightAndShutdown).toHaveBeenCalledTimes(1);
		expect(f.updater.quitAndInstall).toHaveBeenCalledTimes(1);
		expect(await f.controller.restartToUpdate()).toBe(false);
	});
	it("keeps cancellation and incomplete shutdown pending without installation", async () => {
		const f = fixture();
		await f.download();
		f.preflightAndShutdown.mockResolvedValue(false);
		expect(await f.controller.restartToUpdate()).toBe(false);
		expect(f.controller.snapshot()).toEqual({ phase: "downloaded", pending: true, reason: "shutdown_incomplete" });
		expect(f.updater.quitAndInstall).not.toHaveBeenCalled();
		f.preflightAndShutdown.mockRejectedValue(new Error("private failure detail"));
		expect(await f.controller.restartToUpdate()).toBe(false);
		expect(f.controller.snapshot().reason).toBe("restart_failed");
		expect(JSON.stringify(f.onEvidence.mock.calls)).not.toContain("private failure");
		expect(f.updater.quitAndInstall).not.toHaveBeenCalled();
	});
	it("lets a racing normal Quit win after the shared shutdown promise resolves", async () => {
		const f = fixture();
		await f.download();
		const shutdown = deferred<boolean>();
		f.preflightAndShutdown.mockImplementation(() => shutdown.promise);
		const restart = f.controller.restartToUpdate();
		await Promise.resolve();
		f.isNormalQuitPending.mockReturnValue(true);
		shutdown.resolve(true);
		expect(await restart).toBe(false);
		expect(f.controller.snapshot().reason).toBe("normal_quit");
		expect(f.updater.quitAndInstall).not.toHaveBeenCalled();
	});
	it("does not use before-quit-for-update as a preflight or cancellation gate", async () => {
		const f = fixture();
		f.updater.emit("before-quit-for-update");
		expect(f.preflightAndShutdown).not.toHaveBeenCalled();
		expect(await f.controller.restartToUpdate()).toBe(false);
		await f.download();
		expect(await f.controller.restartToUpdate()).toBe(true);
		f.updater.emit("before-quit-for-update");
		expect(f.preflightAndShutdown).toHaveBeenCalledTimes(1);
	});
	it("does not install after disposal while cleanup is pending", async () => {
		const f = fixture();
		await f.download();
		const shutdown = deferred<boolean>();
		f.preflightAndShutdown.mockImplementation(() => shutdown.promise);
		const restart = f.controller.restartToUpdate();
		await Promise.resolve();
		f.controller.dispose();
		shutdown.resolve(true);
		expect(await restart).toBe(false);
		expect(f.updater.quitAndInstall).not.toHaveBeenCalled();
		expect(f.updater.listenerCount("update-downloaded")).toBe(0);
	});
});
