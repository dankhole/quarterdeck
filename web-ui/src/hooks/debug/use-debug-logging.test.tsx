import { act, createElement, useEffect } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const setLogLevelOnServerMock = vi.hoisted(() => vi.fn());
const setClientLogLevelMock = vi.hoisted(() => vi.fn());
const setClientLoggingEnabledMock = vi.hoisted(() => vi.fn());
const registerClientLogCallbackMock = vi.hoisted(() => vi.fn());
const setGlobalErrorCallbackMock = vi.hoisted(() => vi.fn());
const showAppToastMock = vi.hoisted(() => vi.fn());

vi.mock("@/components/app-toaster", () => ({
	showAppToast: showAppToastMock,
}));

vi.mock("@/runtime/runtime-config-query", () => ({
	setLogLevel: setLogLevelOnServerMock,
}));

vi.mock("@/utils/client-logger", () => ({
	registerClientLogCallback: registerClientLogCallbackMock,
	setClientLoggingEnabled: setClientLoggingEnabledMock,
	setClientLogLevel: setClientLogLevelMock,
}));

vi.mock("@/utils/global-error-capture", () => ({
	setGlobalErrorCallback: setGlobalErrorCallbackMock,
}));

import { type UseDebugLoggingResult, useDebugLogging } from "@/hooks/debug/use-debug-logging";
import type { RuntimeDebugLogEntry } from "@/runtime/types";

interface Deferred<T> {
	promise: Promise<T>;
	resolve: (value: T) => void;
	reject: (error: unknown) => void;
}

function createDeferred<T>(): Deferred<T> {
	let resolve: Deferred<T>["resolve"] | null = null;
	let reject: Deferred<T>["reject"] | null = null;
	const promise = new Promise<T>((promiseResolve, promiseReject) => {
		resolve = promiseResolve;
		reject = promiseReject;
	});
	if (!resolve || !reject) {
		throw new Error("Failed to create deferred promise.");
	}
	return { promise, resolve, reject };
}

function HookHarness({
	currentProjectId,
	logLevel,
	debugLogEntries,
	onSnapshot,
}: {
	currentProjectId: string | null;
	logLevel: UseDebugLoggingResult["logLevel"];
	debugLogEntries: RuntimeDebugLogEntry[];
	onSnapshot: (snapshot: UseDebugLoggingResult) => void;
}): null {
	const snapshot = useDebugLogging({ currentProjectId, logLevel, debugLogEntries });
	useEffect(() => {
		onSnapshot(snapshot);
	}, [onSnapshot, snapshot]);
	return null;
}

describe("useDebugLogging", () => {
	let container: HTMLDivElement;
	let root: Root;
	let latestSnapshot: UseDebugLoggingResult;
	let previousActEnvironment: boolean | undefined;

	beforeEach(() => {
		setLogLevelOnServerMock.mockReset();
		setClientLogLevelMock.mockReset();
		setClientLoggingEnabledMock.mockReset();
		registerClientLogCallbackMock.mockReset();
		setGlobalErrorCallbackMock.mockReset();
		showAppToastMock.mockReset();
		previousActEnvironment = (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean })
			.IS_REACT_ACT_ENVIRONMENT;
		(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
		container = document.createElement("div");
		document.body.appendChild(container);
		root = createRoot(container);
		latestSnapshot = null as unknown as UseDebugLoggingResult;
	});

	afterEach(() => {
		act(() => {
			root.unmount();
		});
		container.remove();
		if (previousActEnvironment === undefined) {
			delete (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
		} else {
			(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
				previousActEnvironment;
		}
	});

	function renderHook(logLevel: UseDebugLoggingResult["logLevel"]): void {
		act(() => {
			root.render(
				createElement(HookHarness, {
					currentProjectId: "project-1",
					logLevel,
					debugLogEntries: [],
					onSnapshot: (snapshot: UseDebugLoggingResult) => {
						latestSnapshot = snapshot;
					},
				}),
			);
		});
	}

	it("shows a selected log level immediately while the runtime update is pending", () => {
		const deferred = createDeferred<{ ok: boolean; level: UseDebugLoggingResult["logLevel"] }>();
		setLogLevelOnServerMock.mockReturnValue(deferred.promise);

		renderHook("warn");

		act(() => {
			latestSnapshot.setLogLevel("error");
		});

		expect(latestSnapshot.logLevel).toBe("error");
		expect(setLogLevelOnServerMock).toHaveBeenCalledWith("project-1", "error");
		expect(setClientLogLevelMock).toHaveBeenLastCalledWith("error");

		renderHook("warn");

		expect(latestSnapshot.logLevel).toBe("error");
	});

	it("reverts the optimistic log level when the runtime update fails", async () => {
		const deferred = createDeferred<{ ok: boolean; level: UseDebugLoggingResult["logLevel"] }>();
		setLogLevelOnServerMock.mockReturnValue(deferred.promise);

		renderHook("warn");

		act(() => {
			latestSnapshot.setLogLevel("debug");
		});
		expect(latestSnapshot.logLevel).toBe("debug");

		await act(async () => {
			deferred.reject(new Error("runtime busy"));
			await deferred.promise.catch(() => {});
		});

		expect(latestSnapshot.logLevel).toBe("warn");
		expect(setClientLogLevelMock).toHaveBeenLastCalledWith("warn");
		expect(showAppToastMock).toHaveBeenCalledWith({ intent: "danger", message: "Could not update log level" });
	});

	it("lets later runtime stream updates win after the pending level is confirmed", async () => {
		const deferred = createDeferred<{ ok: boolean; level: UseDebugLoggingResult["logLevel"] }>();
		setLogLevelOnServerMock.mockReturnValue(deferred.promise);

		renderHook("warn");

		act(() => {
			latestSnapshot.setLogLevel("error");
		});

		await act(async () => {
			deferred.resolve({ ok: true, level: "error" });
			await deferred.promise;
		});

		expect(latestSnapshot.logLevel).toBe("error");

		renderHook("info");

		expect(latestSnapshot.logLevel).toBe("info");
	});

	it("does not show a failure toast for an obsolete log level request", async () => {
		const firstDeferred = createDeferred<{ ok: boolean; level: UseDebugLoggingResult["logLevel"] }>();
		const secondDeferred = createDeferred<{ ok: boolean; level: UseDebugLoggingResult["logLevel"] }>();
		setLogLevelOnServerMock.mockReturnValueOnce(firstDeferred.promise).mockReturnValueOnce(secondDeferred.promise);

		renderHook("warn");

		act(() => {
			latestSnapshot.setLogLevel("debug");
			latestSnapshot.setLogLevel("error");
		});

		await act(async () => {
			firstDeferred.reject(new Error("obsolete request failed"));
			await firstDeferred.promise.catch(() => {});
		});

		expect(latestSnapshot.logLevel).toBe("error");
		expect(showAppToastMock).not.toHaveBeenCalled();

		await act(async () => {
			secondDeferred.resolve({ ok: true, level: "error" });
			await secondDeferred.promise;
		});
	});
});
