import { describe, expect, it } from "vitest";
import { RuntimeSelection } from "../src/runtime-selection.js";
import {
	desktopPartition,
	desktopUrl,
	externalWebUrl,
	isPermittedHttpPath,
	isPinnedWebSocket,
	runtimeOrigin,
} from "../src/security-policy.js";

describe("desktop transport boundaries", () => {
	it("pins only a canonical local runtime endpoint", () => {
		expect(runtimeOrigin("http://127.0.0.1:54321")).toBe("http://127.0.0.1:54321");
		for (const value of [
			"http://localhost:80",
			"http://127.0.0.1:0",
			"http://127.0.0.1:65536",
			"http://127.0.0.1:80/",
			"http://127.0.0.1:80?token=x",
			"http://user@127.0.0.1:80",
			"https://127.0.0.1:80",
			"http://127.0.0.1:080",
		]) {
			expect(() => runtimeOrigin(value)).toThrow();
		}
	});

	it("admits all three exact WebSocket routes, with their ordinary query parameters", () => {
		for (const path of ["/api/runtime/ws", "/api/terminal/io", "/api/terminal/control"]) {
			expect(isPinnedWebSocket(`ws://127.0.0.1:12345${path}?projectId=synthetic`, "http://127.0.0.1:12345")).toBe(
				true,
			);
		}
		for (const url of [
			"ws://127.0.0.1:12346/api/runtime/ws",
			"ws://localhost:12345/api/runtime/ws",
			"ws://127.0.0.1:12345/api/diagnostics",
			"ws://127.0.0.1:12345/api/runtime/ws/",
			"ws://127.0.0.1:12345/api/runtime/%77s",
			"ws://user@127.0.0.1:12345/api/runtime/ws",
			"ws://127.0.0.1:12345/api/runtime/ws#fragment",
		]) {
			expect(isPinnedWebSocket(url, "http://127.0.0.1:12345")).toBe(false);
		}
	});

	it("blocks other API scopes including percent-encoded route bypasses", () => {
		expect(isPermittedHttpPath("/api/trpc/runtime.startTaskSession", "POST")).toBe(true);
		expect(isPermittedHttpPath("/api/trpc/runtime.getConfig,projects.list", "GET")).toBe(true);
		expect(isPermittedHttpPath("/api/diagnostics/browser-status", "GET")).toBe(true);
		expect(isPermittedHttpPath("/api/diagnostics/browser-export", "POST")).toBe(true);
		expect(isPermittedHttpPath("/assets/index.js", "GET")).toBe(true);
		for (const path of [
			"/api/diagnostics",
			"/%61pi/diagnostics",
			"/api%2fdiagnostics",
			"/api/agent-lab/host-events",
			"/api/trpc-other",
			"/api/trpc/hooks.ingest",
			"/api/trpc/runtime.getConfig,hooks.ingest",
			"/api/trpc/runtime.getConfig%2chooks%2eingest",
			"/api/trpc/management.shutdown",
			"/__desktop/retry",
			"/%5f_desktop/retry",
			"/assets/%2e%2e/secret",
			"/malformed%",
			"/assets/a%00b",
		]) {
			expect(isPermittedHttpPath(path, "GET")).toBe(false);
		}
		expect(isPermittedHttpPath("/assets/index.js", "POST")).toBe(false);
		expect(isPermittedHttpPath("/api/trpc/project.load", "DELETE")).toBe(false);
	});

	it("denies native notification subscription claims in renderer WebSocket queries", () => {
		for (const path of ["/api/runtime/ws", "/api/terminal/io", "/api/terminal/control"]) {
			for (const query of [
				"notificationPresentation=desktop-main",
				"notificationPresentation=",
				"notificationOnly=false",
				"notificationOnly",
				"%6eotificationPresentation=desktop-main",
				"notification%4fnly=1",
				"projectId=synthetic&notificationOnly=0&notificationOnly=1",
			]) {
				expect(isPinnedWebSocket(`ws://127.0.0.1:12345${path}?${query}`, "http://127.0.0.1:12345")).toBe(false);
			}
		}
	});

	it("keeps storage keyed to state home instead of the changing runtime port", () => {
		expect(desktopPartition("/tmp/lab/state")).toBe(desktopPartition("/tmp/lab/state"));
		expect(desktopPartition("/tmp/lab/state")).not.toBe(desktopPartition("/tmp/other/state"));
		expect(desktopPartition("/tmp/lab/state")).toMatch(/^persist:quarterdeck-[a-f0-9]{64}$/);
	});

	it("permits only the dedicated application host and ordinary external web links", () => {
		expect(desktopUrl("app://quarterdeck/projects/synthetic")).not.toBeNull();
		for (const url of ["app://other/", "app://user@quarterdeck/", "app://quarterdeck:123/", "file:///tmp/lab"])
			expect(desktopUrl(url)).toBeNull();
		expect(externalWebUrl("https://example.test/docs")).toBe("https://example.test/docs");
		for (const url of ["file:///tmp/lab", "javascript:alert(1)", "https://secret@example.test", "app://quarterdeck/"])
			expect(externalWebUrl(url)).toBeNull();
	});
});

describe("runtime generation selection", () => {
	it("aborts old generation work and does not disclose credentials in bootstrap", () => {
		const selection = new RuntimeSelection();
		const previous = selection.select({
			generation: "generation-one",
			origin: "http://127.0.0.1:10001",
			clientToken: "a".repeat(43),
		});
		const bootstrap = selection.bootstrap(previous.generation);
		expect(JSON.stringify(bootstrap)).not.toContain(previous.clientToken);
		selection.select({ generation: "generation-two", origin: "http://127.0.0.1:10002", clientToken: "b".repeat(43) });
		expect(previous.signal.aborted).toBe(true);
		expect(selection.bootstrap(previous.generation)).toBeNull();
		selection.clear();
		expect(selection.get()).toBeNull();
	});

	it("rejects an invalid replacement without changing the current generation", () => {
		const selection = new RuntimeSelection();
		const previous = selection.select({
			generation: "first",
			origin: "http://127.0.0.1:10001",
			clientToken: "a".repeat(43),
		});
		expect(() =>
			selection.select({ generation: "second", origin: "http://example.test:10002", clientToken: "b".repeat(43) }),
		).toThrow();
		expect(selection.get()).toBe(previous);
		expect(previous.signal.aborted).toBe(false);
	});
});
