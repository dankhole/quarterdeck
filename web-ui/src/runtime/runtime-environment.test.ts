import { afterEach, describe, expect, it, vi } from "vitest";
import {
	getRuntimeEnvironment,
	getRuntimeWebSocketUrl,
	resolveRuntimeEnvironment,
} from "@/runtime/runtime-environment";
import type { DesktopBridge } from "../../../src/shared/desktop-bridge-contract";

const desktopLocation = { protocol: "app:", host: "quarterdeck" };
const desktopBridge: DesktopBridge = {
	version: 1,
	bootstrap: {
		runtimeOrigin: "http://127.0.0.1:54321",
		runtimeGeneration: "generation-1",
		capabilities: { desktop: true, nativeDialogs: false, nativeNotifications: false },
	},
};

afterEach(() => {
	vi.unstubAllGlobals();
});

describe("resolveRuntimeEnvironment", () => {
	it.each(["http:", "https:"])("preserves the ordinary %s browser origin without a bridge", (protocol) => {
		expect(resolveRuntimeEnvironment({ protocol, host: "example.test:4321" }, undefined)).toEqual({
			kind: "browser",
			runtimeOrigin: `${protocol}//example.test:4321`,
		});
	});

	it("reads only non-secret validated desktop bootstrap metadata", () => {
		expect(resolveRuntimeEnvironment(desktopLocation, desktopBridge)).toEqual({
			kind: "desktop",
			runtimeOrigin: "http://127.0.0.1:54321",
			runtimeGeneration: "generation-1",
			capabilities: { desktop: true, nativeDialogs: false, nativeNotifications: false },
		});
	});

	it("accepts only the optional allowlisted native command/preflight functions", () => {
		expect(
			resolveRuntimeEnvironment(desktopLocation, {
				...desktopBridge,
				onCommand: () => () => {},
				onOpenProject: () => () => {},
				publishCommandAvailability: () => {},
				onNotificationTarget: () => () => {},
				reportNotificationContext: () => {},
				onQuitPreflight: () => () => {},
				respondQuitPreflight: () => {},
				saveEditorDraft: async () => ({ kind: "cancelled" }),
			}).kind,
		).toBe("desktop");
		for (const extra of [
			{ onCommand: "execute" },
			{ onOpenProject: "execute" },
			{ publishCommandAvailability: { commands: [] } },
			{ onNotificationTarget: "navigate" },
			{ reportNotificationContext: {} },
			{ respondQuitPreflight: null },
			{ saveEditorDraft: true },
			{ invoke: () => {} },
		])
			expect(() => resolveRuntimeEnvironment(desktopLocation, { ...desktopBridge, ...extra })).toThrow(
				"Desktop runtime bootstrap is invalid",
			);
	});

	it.each(["app:", "file:", "ftp:"])("rejects %s without a valid desktop bridge", (protocol) => {
		expect(() => resolveRuntimeEnvironment({ protocol, host: "quarterdeck" }, undefined)).toThrow(
			"Runtime transport requires an HTTP origin or a valid desktop bootstrap.",
		);
	});

	it.each([
		{ protocol: "https:", host: "example.test" },
		{ protocol: "app:", host: "another-app" },
	])("rejects a bridge outside the approved desktop origin: $protocol//$host", (location) => {
		expect(() => resolveRuntimeEnvironment(location, desktopBridge)).toThrow("Desktop runtime bootstrap is invalid");
	});

	it.each([
		null,
		[],
		{},
		{ ...desktopBridge, version: 2 },
		{ ...desktopBridge, clientToken: "must-not-be-exposed" },
		{ version: 1, bootstrap: null },
		{ version: 1, bootstrap: { ...desktopBridge.bootstrap, runtimeGeneration: "" } },
		{ version: 1, bootstrap: { ...desktopBridge.bootstrap, runtimeGeneration: "x".repeat(129) } },
		{ version: 1, bootstrap: { ...desktopBridge.bootstrap, runtimeGeneration: "generation\n1" } },
		{ version: 1, bootstrap: { ...desktopBridge.bootstrap, token: "must-not-be-exposed" } },
		{ version: 1, bootstrap: { ...desktopBridge.bootstrap, capabilities: [] } },
		{ version: 1, bootstrap: { ...desktopBridge.bootstrap, capabilities: { desktop: true } } },
		{
			version: 1,
			bootstrap: {
				...desktopBridge.bootstrap,
				capabilities: { desktop: false, nativeDialogs: false, nativeNotifications: false },
			},
		},
		{
			version: 1,
			bootstrap: {
				...desktopBridge.bootstrap,
				capabilities: { desktop: true, nativeDialogs: "false", nativeNotifications: false },
			},
		},
	])("fails closed on malformed or unsupported bridge data (%#)", (bridge) => {
		expect(() => resolveRuntimeEnvironment(desktopLocation, bridge)).toThrow("Desktop runtime bootstrap is invalid");
	});

	it.each([
		"https://127.0.0.1:54321",
		"ws://127.0.0.1:54321",
		"file:///tmp/runtime",
		"http://example.test:54321",
		"http://127.0.0.1.example.test:54321",
		"http://localhost:54321",
		"http://[::1]:54321",
		"http://2130706433:54321",
		"http://127.1:54321",
		"http://127.0.0.1",
		"http://127.0.0.1:0",
		"http://127.0.0.1:65536",
		"http://127.0.0.1:054321",
		"http://user:secret@127.0.0.1:54321",
		"http://127.0.0.1:54321/",
		"http://127.0.0.1:54321/api",
		"http://127.0.0.1:54321?token=secret",
		"http://127.0.0.1:54321#secret",
		" http://127.0.0.1:54321",
	])("rejects unsafe or noncanonical desktop endpoint %s", (runtimeOrigin) => {
		expect(() =>
			resolveRuntimeEnvironment(desktopLocation, {
				...desktopBridge,
				bootstrap: { ...desktopBridge.bootstrap, runtimeOrigin },
			}),
		).toThrow("Desktop runtime bootstrap is invalid");
	});
});

describe("getRuntimeWebSocketUrl", () => {
	it.each(["/api/runtime/ws", "/api/terminal/io", "/api/terminal/control"] as const)(
		"resolves desktop %s against the explicit endpoint with no credentials",
		(path) => {
			vi.stubGlobal("window", { location: desktopLocation, quarterdeckDesktop: desktopBridge });
			const url = getRuntimeWebSocketUrl(path);
			expect(url.toString()).toBe(`ws://127.0.0.1:54321${path}`);
			expect(url.username).toBe("");
			expect(url.password).toBe("");
			expect(url.search).toBe("");
			expect(url.hash).toBe("");
		},
	);

	it.each([
		["http:", "ws:"],
		["https:", "wss:"],
	])("keeps browser %s WebSocket behavior", (protocol, websocketProtocol) => {
		vi.stubGlobal("window", { location: { protocol, host: "example.test:4321" } });
		expect(getRuntimeWebSocketUrl("/api/runtime/ws").toString()).toBe(
			`${websocketProtocol}//example.test:4321/api/runtime/ws`,
		);
		expect(getRuntimeEnvironment().kind).toBe("browser");
	});
});
