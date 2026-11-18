import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	runtimeOwnerDescriptorSchema,
	runtimeTransportCapabilitiesSchema,
} from "../../../src/core/api/runtime-management.js";
import { QUARTERDECK_RUNTIME_PROTOCOL_VERSION } from "../../../src/core/api/runtime-protocol.js";
import {
	enrollDesktopClient,
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
	it("rejects the removed browser contract before sending any management credentials", async () => {
		const descriptor = owner();
		descriptor.runtimeProtocolVersion = 12;
		const request = vi.fn();
		vi.stubGlobal("fetch", request);
		await expect(verifyRuntimeOwner(descriptor, true)).rejects.toMatchObject({ code: "incompatible_runtime" });
		expect(request).not.toHaveBeenCalled();
		expect(
			runtimeTransportCapabilitiesSchema.safeParse({
				...descriptor.capabilities,
				browserHttp: true,
				browserWebSocket: true,
			}).success,
		).toBe(false);
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
	])("verifies an internal runtime on wildcard bind %s using loopback management", async (host, origin) => {
		const descriptor = owner();
		descriptor.endpoint = { host, port: 3580 };
		const { managementToken: _private, ...publicDescriptor } = descriptor;
		const request = vi.fn().mockResolvedValueOnce(Response.json({ descriptor: publicDescriptor }));
		vi.stubGlobal("fetch", request);
		await expect(verifyRuntimeOwner(descriptor, false)).resolves.toBe(origin);
		expect(request.mock.calls[0]?.[0]).toBe(`${origin}/api/management/status`);
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
	it("enrolls only desktop credentials and rejects a changed enrollment generation", async () => {
		const descriptor = owner();
		const request = vi.fn().mockResolvedValue(Response.json({ generation: descriptor.generation, enrolled: true }));
		vi.stubGlobal("fetch", request);
		await enrollDesktopClient(descriptor, "b".repeat(43));
		expect(request.mock.calls[0]?.[0]).toBe("http://127.0.0.1:3580/api/management/client-bootstrap");
		expect(request.mock.calls[0]?.[1]).toMatchObject({
			method: "POST",
			body: JSON.stringify({
				generation: descriptor.generation,
				kind: "desktop",
				clientToken: "b".repeat(43),
				origin: "app://quarterdeck",
			}),
		});
		request.mockResolvedValue(Response.json({ generation: randomUUID(), enrolled: true }));
		await expect(enrollDesktopClient(descriptor, "b".repeat(43))).rejects.toThrow("generation changed");
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
