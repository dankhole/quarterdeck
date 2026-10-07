import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { type FetchTransport, proxyRuntimeRequest } from "../src/protocol-proxy.js";
import { RuntimeSelection } from "../src/runtime-selection.js";
import { DESKTOP_TOKEN_HEADER } from "../src/security-policy.js";

const TOKEN = "a".repeat(43);
const servers: Server[] = [];
afterEach(async () => {
	await Promise.all(
		servers.splice(0).map(
			(server) =>
				new Promise<void>((resolve) => {
					server.closeAllConnections();
					server.close(() => resolve());
				}),
		),
	);
});

async function listen(server: Server): Promise<string> {
	servers.push(server);
	await new Promise<void>((resolve, reject) => {
		server.once("error", reject);
		server.listen(0, "127.0.0.1", () => {
			server.off("error", reject);
			resolve();
		});
	});
	return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

function selected(origin: string): RuntimeSelection {
	const selection = new RuntimeSelection();
	selection.select({ generation: "first", origin, clientToken: TOKEN });
	return selection;
}

describe("stable origin HTTP proxy", () => {
	it("preserves a POST body, response status and content type while keeping authentication in main", async () => {
		let body = "";
		let token = "";
		let browserCredential: string | undefined;
		const origin = await listen(
			createServer(async (request, response) => {
				for await (const chunk of request) body += String(chunk);
				token = String(request.headers[DESKTOP_TOKEN_HEADER.toLowerCase()]);
				browserCredential = request.headers.authorization;
				expect(request.headers.origin).toBe("app://quarterdeck");
				expect(request.url).toBe("/api/trpc/runtime.synthetic?batch=1");
				response.writeHead(207, {
					"Content-Type": "application/json",
					"Set-Cookie": "secret=cookie",
					[DESKTOP_TOKEN_HEADER]: TOKEN,
				});
				response.end('{"ok":true}');
			}),
		);
		const request = new Request("app://quarterdeck/api/trpc/runtime.synthetic?batch=1", {
			method: "POST",
			body: '{"task":"synthetic"}',
			headers: { Authorization: "renderer-forgery", [DESKTOP_TOKEN_HEADER]: "renderer-forgery" },
		});
		const response = await proxyRuntimeRequest(request, selected(origin));
		expect(response.status).toBe(207);
		expect(response.headers.get("content-type")).toBe("application/json");
		expect(await response.json()).toEqual({ ok: true });
		expect(body).toBe('{"task":"synthetic"}');
		expect(token).toBe(TOKEN);
		expect(browserCredential).toBeUndefined();
		expect(response.headers.get("set-cookie")).toBeNull();
		expect(response.headers.get(DESKTOP_TOKEN_HEADER)).toBeNull();
	});

	it("rejects arbitrary hosts, cross-origin initiators, privileged routes and redirects without forwarding credentials", async () => {
		let calls = 0;
		const transport: FetchTransport = async () => {
			calls++;
			return new Response(null, { status: 302, headers: { Location: "https://example.test/" } });
		};
		const selection = selected("http://127.0.0.1:12345");
		for (const request of [
			new Request("app://other/"),
			new Request("app://quarterdeck/api/diagnostics"),
			Object.assign(new Request("app://quarterdeck/"), { initiatorOrigin: "https://example.test" }),
		])
			expect((await proxyRuntimeRequest(request, selection, transport)).status).toBe(403);
		expect(calls).toBe(0);
		expect((await proxyRuntimeRequest(new Request("app://quarterdeck/"), selection, transport)).status).toBe(502);
		expect(calls).toBe(1);
	});

	it("does not buffer a streaming response and cancels it when the owner generation changes", async () => {
		let disconnected: Promise<void> = Promise.resolve();
		const origin = await listen(
			createServer((_request, response) => {
				disconnected = new Promise((resolve) => response.once("close", resolve));
				response.writeHead(200, { "Content-Type": "text/plain" });
				response.write("first chunk");
			}),
		);
		const selection = selected(origin);
		const response = await proxyRuntimeRequest(new Request("app://quarterdeck/assets/stream.txt"), selection);
		const reader = response.body?.getReader();
		expect(reader).toBeDefined();
		expect(new TextDecoder().decode((await reader?.read())?.value)).toBe("first chunk");
		selection.clear();
		await expect(reader?.read()).rejects.toThrow();
		await disconnected;
	});

	it("cancels upstream work when the renderer cancels an HTTP request", async () => {
		let accepted: () => void = () => undefined;
		const started = new Promise<void>((resolve) => {
			accepted = resolve;
		});
		const origin = await listen(
			createServer((_request, response) => {
				response.on("error", () => undefined);
				accepted();
			}),
		);
		const controller = new AbortController();
		const pending = proxyRuntimeRequest(
			new Request("app://quarterdeck/assets/delayed.txt", { signal: controller.signal }),
			selected(origin),
		);
		await started;
		controller.abort();
		expect((await pending).status).toBe(503);
	});

	it("applies an origin-specific CSP to served HTML and never authorizes another runtime port", async () => {
		const origin = "http://127.0.0.1:12345";
		const response = await proxyRuntimeRequest(
			new Request("app://quarterdeck/"),
			selected(origin),
			async () => new Response("<html></html>", { headers: { "Content-Type": "text/html" } }),
		);
		const csp = response.headers.get("Content-Security-Policy");
		expect(csp).toContain("connect-src 'self' ws://127.0.0.1:12345");
		expect(csp).toContain("script-src 'self'");
		expect(csp).toContain("frame-src 'none'");
		expect(response.headers.get("cache-control")).toBe("no-store");
	});
});
