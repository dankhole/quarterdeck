import { EventEmitter } from "node:events";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
	type GracefulShutdownProcess,
	getExitCodeForSignal,
	type HandledShutdownSignal,
	installGracefulShutdownHandlers,
} from "../../src/core";

function createDeferredPromise() {
	let resolvePromise!: () => void;
	const promise = new Promise<void>((resolve) => {
		resolvePromise = resolve;
	});
	return {
		promise,
		resolve: resolvePromise,
	};
}

function createProcessDouble(): GracefulShutdownProcess & {
	emitSignal: (signal: HandledShutdownSignal) => void;
	listenerCount: (signal: HandledShutdownSignal) => number;
} {
	const emitter = new EventEmitter();
	const processDouble: GracefulShutdownProcess & {
		emitSignal: (signal: HandledShutdownSignal) => void;
		listenerCount: (signal: HandledShutdownSignal) => number;
	} = {
		on(signal, listener) {
			emitter.on(signal, listener);
			return processDouble;
		},
		off(signal, listener) {
			emitter.off(signal, listener);
			return processDouble;
		},
		emitSignal(signal) {
			emitter.emit(signal);
		},
		listenerCount(signal) {
			return emitter.listenerCount(signal);
		},
	};
	return processDouble;
}

describe("installGracefulShutdownHandlers", () => {
	afterEach(() => {
		vi.useRealTimers();
	});

	it("suppresses an immediate duplicate SIGINT by default, including direct launches", async () => {
		vi.useFakeTimers();

		const processDouble = createProcessDouble();
		const exit = vi.fn();
		const onSecondSignal = vi.fn();
		const deferred = createDeferredPromise();

		installGracefulShutdownHandlers({
			process: processDouble,
			delayMs: 10_000,
			exit,
			onSecondSignal,
			onShutdown: async () => {
				await deferred.promise;
			},
		});

		processDouble.emitSignal("SIGINT");
		vi.advanceTimersByTime(100);
		processDouble.emitSignal("SIGINT");

		expect(onSecondSignal).not.toHaveBeenCalled();
		expect(exit).not.toHaveBeenCalled();

		deferred.resolve();
		await Promise.resolve();
		await Promise.resolve();

		expect(exit).toHaveBeenCalledTimes(1);
		expect(exit).toHaveBeenCalledWith(130);
	});

	it("keeps the duplicate window anchored to the first signal", () => {
		vi.useFakeTimers();
		const processDouble = createProcessDouble();
		const exit = vi.fn();
		installGracefulShutdownHandlers({
			process: processDouble,
			delayMs: 10_000,
			exit,
			onShutdown: () => new Promise(() => {}),
		});

		processDouble.emitSignal("SIGINT");
		vi.advanceTimersByTime(750);
		processDouble.emitSignal("SIGINT");
		expect(exit).not.toHaveBeenCalled();
		vi.advanceTimersByTime(1);
		processDouble.emitSignal("SIGINT");
		expect(exit).toHaveBeenCalledExactlyOnceWith(130);
	});

	it("force-exits immediately on a different signal", () => {
		vi.useFakeTimers();
		const processDouble = createProcessDouble();
		const exit = vi.fn();
		installGracefulShutdownHandlers({
			process: processDouble,
			delayMs: 10_000,
			exit,
			onShutdown: () => new Promise(() => {}),
		});

		processDouble.emitSignal("SIGINT");
		processDouble.emitSignal("SIGTERM");
		expect(exit).toHaveBeenCalledExactlyOnceWith(143);
	});

	it("preserves the shutdown deadline when duplicates arrive", () => {
		vi.useFakeTimers();
		const processDouble = createProcessDouble();
		const exit = vi.fn();
		const onTimeout = vi.fn();
		installGracefulShutdownHandlers({
			process: processDouble,
			delayMs: 10_000,
			exit,
			onTimeout,
			onShutdown: () => new Promise(() => {}),
		});

		processDouble.emitSignal("SIGINT");
		vi.advanceTimersByTime(750);
		processDouble.emitSignal("SIGINT");
		vi.advanceTimersByTime(9_250);
		expect(onTimeout).toHaveBeenCalledExactlyOnceWith(10_000);
		expect(exit).toHaveBeenCalledExactlyOnceWith(1);
	});

	it("still force-exits on a later second Ctrl+C", () => {
		vi.useFakeTimers();

		const processDouble = createProcessDouble();
		const exit = vi.fn();
		const onSecondSignal = vi.fn();
		const deferred = createDeferredPromise();

		installGracefulShutdownHandlers({
			process: processDouble,
			delayMs: 10_000,
			exit,
			onSecondSignal,
			onShutdown: async () => {
				await deferred.promise;
			},
		});

		processDouble.emitSignal("SIGINT");
		vi.advanceTimersByTime(1_000);
		processDouble.emitSignal("SIGINT");

		expect(onSecondSignal).toHaveBeenCalledTimes(1);
		expect(onSecondSignal).toHaveBeenCalledWith("SIGINT");
		expect(exit).toHaveBeenCalledTimes(1);
		expect(exit).toHaveBeenCalledWith(130);

		deferred.resolve();
	});

	it("runs a programmatic shutdown request without relying on a process signal", async () => {
		const processDouble = createProcessDouble();
		const exit = vi.fn();
		const onShutdown = vi.fn(async () => undefined);

		const controller = installGracefulShutdownHandlers({
			process: processDouble,
			delayMs: 10_000,
			exit,
			onShutdown,
		});

		controller.requestShutdown("SIGTERM");
		controller.requestShutdown("SIGTERM");
		await Promise.resolve();
		await Promise.resolve();

		expect(onShutdown).toHaveBeenCalledTimes(1);
		expect(onShutdown).toHaveBeenCalledWith("SIGTERM");
		expect(exit).toHaveBeenCalledTimes(1);
		expect(exit).toHaveBeenCalledWith(143);
	});

	it("handles Windows console-close and Ctrl+Break signals but omits SIGQUIT", () => {
		const processDouble = createProcessDouble();
		const controller = installGracefulShutdownHandlers({
			process: processDouble,
			platform: "win32",
			delayMs: 10_000,
			exit: vi.fn(),
			onShutdown: vi.fn(async () => undefined),
		});

		expect(processDouble.listenerCount("SIGHUP")).toBe(1);
		expect(processDouble.listenerCount("SIGBREAK")).toBe(1);
		expect(processDouble.listenerCount("SIGQUIT")).toBe(0);
		controller.uninstall();
	});

	it("does not treat a signal racing a programmatic request as a force-exit", async () => {
		vi.useFakeTimers();

		const processDouble = createProcessDouble();
		const exit = vi.fn();
		const onSecondSignal = vi.fn();
		const deferred = createDeferredPromise();
		const controller = installGracefulShutdownHandlers({
			process: processDouble,
			delayMs: 10_000,
			exit,
			onSecondSignal,
			onShutdown: async () => {
				await deferred.promise;
			},
		});

		controller.requestShutdown("SIGTERM");
		vi.advanceTimersByTime(100);
		processDouble.emitSignal("SIGINT");

		expect(onSecondSignal).not.toHaveBeenCalled();
		expect(exit).not.toHaveBeenCalled();

		deferred.resolve();
		await Promise.resolve();
		await Promise.resolve();

		expect(exit).toHaveBeenCalledTimes(1);
		expect(exit).toHaveBeenCalledWith(143);
	});

	it("still force-exits on a later signal after a programmatic request", () => {
		vi.useFakeTimers();

		const processDouble = createProcessDouble();
		const exit = vi.fn();
		const onSecondSignal = vi.fn();
		const deferred = createDeferredPromise();
		const controller = installGracefulShutdownHandlers({
			process: processDouble,
			delayMs: 10_000,
			exit,
			onSecondSignal,
			onShutdown: async () => {
				await deferred.promise;
			},
		});

		controller.requestShutdown("SIGTERM");
		vi.advanceTimersByTime(1_000);
		processDouble.emitSignal("SIGINT");

		expect(onSecondSignal).toHaveBeenCalledTimes(1);
		expect(onSecondSignal).toHaveBeenCalledWith("SIGINT");
		expect(exit).toHaveBeenCalledTimes(1);
		expect(exit).toHaveBeenCalledWith(130);

		deferred.resolve();
	});
});

describe("getExitCodeForSignal", () => {
	it("maps handled shutdown signals to shell-standard exit codes", () => {
		expect(getExitCodeForSignal("SIGHUP")).toBe(129);
		expect(getExitCodeForSignal("SIGINT")).toBe(130);
		expect(getExitCodeForSignal("SIGQUIT")).toBe(131);
		expect(getExitCodeForSignal("SIGTERM")).toBe(143);
		expect(getExitCodeForSignal("SIGBREAK")).toBe(149);
	});
});
