import { describe, expect, it, vi } from "vitest";
import { verifyInstalledRuntimeAccess } from "../../scripts/package-smoke-runtime";
import type { RuntimeOwnerDescriptor } from "../../src/core/api/runtime-management";

const descriptor: RuntimeOwnerDescriptor = {
	version: 1,
	generation: "11223344-1234-4234-8234-123456789abc",
	canonicalStateHome: "/synthetic/state",
	process: { pid: 12345, creationIdentity: "synthetic-birth" },
	status: "ready",
	endpoint: { host: "127.0.0.1", port: 1234 },
	quarterdeckVersion: "0.0.0",
	runtimeProtocolVersion: 1,
	managementProtocolVersion: 1,
	capabilities: { transportVersion: 1, desktopProxy: true, desktopBridgeVersion: 1 },
	startedAt: "2026-01-01T00:00:00.000Z",
	readyAt: "2026-01-01T00:00:00.000Z",
	managementToken: "x".repeat(43),
};

function fixture() {
	let enrolled = false;
	let token: string | undefined;
	const enroll = vi.fn(async (_descriptor: RuntimeOwnerDescriptor, clientToken: string) => {
		enrolled = true;
		token = clientToken;
	});
	const revoke = vi.fn(async () => {
		enrolled = false;
	});
	const verify = vi.fn(async () => "http://127.0.0.1:1234");
	const fetchImpl = vi.fn<typeof fetch>(async (input, init) => {
		const headers = new Headers(init?.headers);
		const admitted =
			enrolled &&
			headers.get("origin") === "app://quarterdeck" &&
			headers.get("x-quarterdeck-desktop-token") === token;
		if (!admitted) return new Response("", { status: 401 });
		const path = new URL(String(input)).pathname;
		if (path.startsWith("/assets/")) return new Response("/* packaged asset */", { status: 200 });
		if (path === "/")
			return new Response(
				'<script src="/assets/index.js"></script><link rel="stylesheet" href="/assets/index.css">',
				{ status: 200, headers: { "content-type": "text/html" } },
			);
		return new Response(JSON.stringify({ result: { data: { projects: [] } } }), {
			status: 200,
			headers: { "content-type": "application/json" },
		});
	});
	return { enroll, revoke, verify, fetchImpl };
}

describe("packed internal runtime smoke", () => {
	it("checks management identity, desktop enrollment/revocation, no anonymous admission and authenticated packaged renderer assets", async () => {
		const f = fixture();
		await verifyInstalledRuntimeAccess(descriptor, f);
		expect(f.verify).toHaveBeenCalledExactlyOnceWith(descriptor, true);
		expect(f.enroll).toHaveBeenCalledOnce();
		expect(f.revoke).toHaveBeenCalledExactlyOnceWith(descriptor, expect.stringMatching(/^[\w-]{43}$/));
		expect(f.fetchImpl.mock.calls.map(([url]) => new URL(String(url)).pathname)).toEqual([
			"/api/trpc/projects.list",
			"/api/runtime/client-bootstrap",
			"/",
			"/api/trpc/projects.list",
			"/",
			"/assets/index.js",
			"/assets/index.css",
			"/api/trpc/projects.list",
		]);
		expect(f.fetchImpl.mock.calls.every(([, options]) => options?.redirect === "error")).toBe(true);
		expect(f.fetchImpl.mock.calls.every(([, options]) => !new Headers(options?.headers).has("cookie"))).toBe(true);
	});
	it("rejects a runtime that admits ordinary unauthenticated clients", async () => {
		const f = fixture();
		f.fetchImpl.mockResolvedValueOnce(new Response("{}", { status: 200 }));
		await expect(verifyInstalledRuntimeAccess(descriptor, f)).rejects.toThrow("unauthenticated");
		expect(f.enroll).not.toHaveBeenCalled();
	});
	it("revokes its desktop credential even if the packed API is broken", async () => {
		const f = fixture();
		f.fetchImpl
			.mockResolvedValueOnce(new Response("", { status: 401 }))
			.mockResolvedValueOnce(new Response("", { status: 401 }))
			.mockResolvedValueOnce(new Response("", { status: 401 }))
			.mockResolvedValueOnce(new Response("", { status: 500 }));
		await expect(verifyInstalledRuntimeAccess(descriptor, f)).rejects.toThrow("management-enrolled");
		expect(f.revoke).toHaveBeenCalledOnce();
	});
	it("does not disclose transport errors containing private request credentials", async () => {
		const f = fixture();
		f.fetchImpl.mockRejectedValueOnce(new Error("secret-token-value"));
		await expect(verifyInstalledRuntimeAccess(descriptor, f)).rejects.toThrow("private credentials withheld");
	});
});
