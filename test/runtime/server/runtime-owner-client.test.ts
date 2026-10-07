import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runtimeOwnerDescriptorSchema } from "../../../src/core/api/runtime-management.js";
import { QUARTERDECK_RUNTIME_PROTOCOL_VERSION } from "../../../src/core/api/runtime-protocol.js";
import {
	createOwnerBrowserBootstrap,
	revokeDesktopClient,
	verifyRuntimeOwner,
} from "../../../src/server/runtime-owner-client.js";

function owner() {
	return runtimeOwnerDescriptorSchema.parse({
		version: 1,
		generation: randomUUID(),
		canonicalStateHome: "/isolated/state",
		process: { pid: 123, creationIdentity: "process-birth-1" },
		status: "ready",
		endpoint: { host: "127.0.0.1", port: 3580 },
		quarterdeckVersion: "0.12.8",
		runtimeProtocolVersion: QUARTERDECK_RUNTIME_PROTOCOL_VERSION,
		managementProtocolVersion: 1,
		capabilities: {
			transportVersion: 1,
			browserHttp: true,
			browserWebSocket: true,
			desktopProxy: true,
			desktopBridgeVersion: 1,
		},
		startedAt: new Date().toISOString(),
		readyAt: new Date().toISOString(),
		managementToken: "a".repeat(43),
	});
}

afterEach(() => vi.unstubAllGlobals());

describe("verified runtime attachment", () => {
	it("requires authenticated identity match without putting credentials in URLs", async () => {
		const descriptor = owner();
		const { managementToken: _private, ...publicDescriptor } = descriptor;
		const request = vi.fn().mockResolvedValue(Response.json({ descriptor: publicDescriptor }));
		vi.stubGlobal("fetch", request);
		await expect(verifyRuntimeOwner(descriptor, true)).resolves.toBe("http://127.0.0.1:3580");
		expect(request.mock.calls[0]?.[0]).toBe("http://127.0.0.1:3580/api/management/status");
		expect(request.mock.calls[0]?.[1]).toMatchObject({
			redirect: "error",
			headers: { authorization: `Bearer ${descriptor.managementToken}` },
		});
	});
	it("rejects a replaced owner even when it serves compatible APIs", async () => {
		const descriptor = owner();
		vi.stubGlobal(
			"fetch",
			vi.fn().mockResolvedValue(Response.json({ descriptor: { ...descriptor, generation: randomUUID() } })),
		);
		await expect(verifyRuntimeOwner(descriptor, true)).rejects.toThrow("identity changed");
	});
	it("rejects unsupported desktop capability before sending credentials", async () => {
		const descriptor = owner();
		descriptor.capabilities.desktopProxy = false;
		const request = vi.fn();
		vi.stubGlobal("fetch", request);
		await expect(verifyRuntimeOwner(descriptor, true)).rejects.toThrow("compatible");
		expect(request).not.toHaveBeenCalled();
	});
	it("does not follow management redirects or accept remote owner endpoints", async () => {
		const descriptor = owner();
		descriptor.endpoint = { host: "example.com", port: 3580 };
		const request = vi.fn();
		vi.stubGlobal("fetch", request);
		await expect(verifyRuntimeOwner(descriptor, false)).rejects.toThrow("loopback");
		expect(request).not.toHaveBeenCalled();
	});
	it.each([
		["0.0.0.0", "http://127.0.0.1:3580"],
		["::", "http://[::1]:3580"],
		["[::]", "http://[::1]:3580"],
	])("attaches a local CLI to wildcard bind %s using loopback management and browser URLs", async (host, origin) => {
		const descriptor = owner();
		descriptor.endpoint = { host, port: 3580 };
		const { managementToken: _private, ...publicDescriptor } = descriptor;
		const request = vi
			.fn()
			.mockResolvedValueOnce(Response.json({ descriptor: publicDescriptor }))
			.mockResolvedValueOnce(
				Response.json({ generation: descriptor.generation, bootstrapPath: "/api/runtime/client-bootstrap?test" }),
			);
		vi.stubGlobal("fetch", request);
		await expect(verifyRuntimeOwner(descriptor, false)).resolves.toBe(origin);
		await expect(createOwnerBrowserBootstrap(descriptor)).resolves.toBe(
			`${origin}/api/runtime/client-bootstrap?test`,
		);
		expect(request.mock.calls[0]?.[0]).toBe(`${origin}/api/management/status`);
		expect(request.mock.calls[1]?.[0]).toBe(`${origin}/api/management/client-bootstrap`);
	});
	it("does not accept a normalized endpoint in place of the original authenticated descriptor", async () => {
		const descriptor = owner();
		descriptor.endpoint = { host: "0.0.0.0", port: 3580 };
		const { managementToken: _private, ...publicDescriptor } = descriptor;
		vi.stubGlobal(
			"fetch",
			vi
				.fn()
				.mockResolvedValue(
					Response.json({ descriptor: { ...publicDescriptor, endpoint: { host: "127.0.0.1", port: 3580 } } }),
				),
		);
		await expect(verifyRuntimeOwner(descriptor, false)).rejects.toThrow("identity changed");
	});
	it.each(["0.0.0.0", "::", "[::]", "::1", "localhost"])(
		"retains the desktop loopback-only binding requirement for %s before sending credentials",
		async (host) => {
			const descriptor = owner();
			descriptor.endpoint = { host, port: 3580 };
			const request = vi.fn();
			vi.stubGlobal("fetch", request);
			await expect(verifyRuntimeOwner(descriptor, true)).rejects.toThrow("bound to 127.0.0.1");
			expect(request).not.toHaveBeenCalled();
		},
	);
	it("accepts only same-generation bootstrap URLs on the dedicated route", async () => {
		const descriptor = owner();
		vi.stubGlobal(
			"fetch",
			vi
				.fn()
				.mockResolvedValue(
					Response.json({ generation: descriptor.generation, bootstrapPath: "https://example.com/" }),
				),
		);
		await expect(createOwnerBrowserBootstrap(descriptor)).rejects.toThrow("Invalid browser launch");
	});
	it("revokes only its enrolled credential through the authenticated management channel", async () => {
		const descriptor = owner();
		const request = vi.fn().mockResolvedValue(Response.json({ generation: descriptor.generation, revoked: true }));
		vi.stubGlobal("fetch", request);
		await revokeDesktopClient(descriptor, "b".repeat(43));
		expect(request.mock.calls[0]?.[0]).toBe("http://127.0.0.1:3580/api/management/client-revoke");
		expect(request.mock.calls[0]?.[1]).toMatchObject({
			method: "POST",
			body: JSON.stringify({ generation: descriptor.generation, kind: "desktop", clientToken: "b".repeat(43) }),
		});
		request.mockResolvedValue(Response.json({ generation: randomUUID(), revoked: true }));
		await expect(revokeDesktopClient(descriptor, "b".repeat(43))).rejects.toThrow("generation changed");
	});
});
