// @vitest-environment node

import { afterEach, describe, expect, it, vi } from "vitest";
import { getTerminalWebSocketUrl } from "@/terminal/terminal-socket-utils";
import type { DesktopBridge } from "../../../src/shared/desktop-bridge-contract";

afterEach(() => {
	vi.unstubAllGlobals();
});

describe("getTerminalWebSocketUrl", () => {
	it.each(["io", "control"] as const)(
		"keeps browser %s sockets on the HTTP origin and encodes identifiers",
		(path) => {
			vi.stubGlobal("window", { location: { protocol: "https:", host: "example.test:4321" } });
			const url = new URL(getTerminalWebSocketUrl(path, "task /&?#", "project ü /&", "client +&#"));
			expect(url.origin).toBe("wss://example.test:4321");
			expect(url.pathname).toBe(`/api/terminal/${path}`);
			expect([...url.searchParams.entries()]).toEqual([
				["taskId", "task /&?#"],
				["projectId", "project ü /&"],
				["clientId", "client +&#"],
			]);
			expect(url.hash).toBe("");
		},
	);

	it.each(["io", "control"] as const)("uses the pinned desktop endpoint for %s", (path) => {
		const bridge: DesktopBridge = {
			version: 1,
			bootstrap: {
				runtimeOrigin: "http://127.0.0.1:54321",
				runtimeGeneration: "generation-1",
				capabilities: { desktop: true, nativeDialogs: false, nativeNotifications: false },
			},
		};
		vi.stubGlobal("window", { location: { protocol: "app:", host: "quarterdeck" }, quarterdeckDesktop: bridge });
		const url = new URL(getTerminalWebSocketUrl(path, "task /&", "project ü", "client ?#"));
		expect(url.origin).toBe("ws://127.0.0.1:54321");
		expect(url.pathname).toBe(`/api/terminal/${path}`);
		expect([...url.searchParams.entries()]).toEqual([
			["taskId", "task /&"],
			["projectId", "project ü"],
			["clientId", "client ?#"],
		]);
		expect(url.username).toBe("");
		expect(url.password).toBe("");
	});

	it.each(["io", "control"] as const)("does not construct a desktop %s URL without bootstrap", (path) => {
		vi.stubGlobal("window", { location: { protocol: "app:", host: "quarterdeck" } });
		expect(() => getTerminalWebSocketUrl(path, "task", "project", "client")).toThrow("valid desktop bootstrap");
	});
});
