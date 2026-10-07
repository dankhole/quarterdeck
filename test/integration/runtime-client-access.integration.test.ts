import { randomBytes, randomUUID } from "node:crypto";
import { once } from "node:events";
import { createServer, request as httpRequest, type IncomingHttpHeaders, type Server } from "node:http";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WebSocket, WebSocketServer } from "ws";
import type { PublicRuntimeOwnerDescriptor } from "../../src/core/api/runtime-management";
import {
	getQuarterdeckRuntimeHost,
	getQuarterdeckRuntimePort,
	setQuarterdeckRuntimeHost,
	setQuarterdeckRuntimePort,
} from "../../src/core/runtime-endpoint";
import { handleHttpRequest, handleSocketUpgrade } from "../../src/server/middleware";
import { RuntimeClientAccess } from "../../src/server/runtime-client-access";
import type { TerminalSessionService } from "../../src/terminal/terminal-session-service";
import type { UpgradeRequest } from "../../src/terminal/terminal-ws-protocol";
import { createTerminalWebSocketBridge, type TerminalWebSocketBridge } from "../../src/terminal/ws-server";

interface HttpResult {
	status: number;
	headers: IncomingHttpHeaders;
	body: string;
}

describe("runtime client admission over HTTP and WebSocket upgrades", () => {
	const originalHost = getQuarterdeckRuntimeHost();
	const originalPort = getQuarterdeckRuntimePort();
	let server: Server;
	let sockets: WebSocketServer;
	let terminalBridge: TerminalWebSocketBridge;
	let access: RuntimeClientAccess;
	let origin: string;
	let descriptor: PublicRuntimeOwnerDescriptor;
	let now: number;
	let desktopToken: string;
	let managementToken: string;
	let clientCalls: number;
	let openProject: ReturnType<typeof vi.fn<(path: string) => Promise<{ projectId: string }>>>;

	function send(
		path: string,
		headers: Record<string, string> = {},
		method = "GET",
		body?: unknown,
		requestOrigin = origin,
	): Promise<HttpResult> {
		return new Promise((resolve, reject) => {
			const request = httpRequest(`${requestOrigin}${path}`, { method, headers }, (response) => {
				const chunks: Buffer[] = [];
				response.on("data", (chunk: Buffer) => chunks.push(chunk));
				response.on("end", () =>
					resolve({
						status: response.statusCode ?? 0,
						headers: response.headers,
						body: Buffer.concat(chunks).toString("utf8"),
					}),
				);
			});
			request.on("error", reject);
			request.end(body === undefined ? undefined : JSON.stringify(body));
		});
	}

	function managementHeaders(): Record<string, string> {
		return {
			authorization: `Bearer ${managementToken}`,
			"x-quarterdeck-runtime-generation": descriptor.generation,
			"content-type": "application/json",
		};
	}

	function desktopHeaders(): Record<string, string> {
		return { origin: "app://quarterdeck", "x-quarterdeck-desktop-token": desktopToken };
	}

	async function bootstrapBrowser(): Promise<string> {
		const response = await send(access.createBrowserBootstrap("/project-a"));
		expect(response.status).toBe(303);
		return response.headers["set-cookie"]?.[0]?.split(";")[0] ?? "";
	}

	function upgrade(path: string, headers: Record<string, string>): Promise<number> {
		return new Promise((resolve, reject) => {
			const socket = new WebSocket(
				`${origin.replace("http:", "ws:")}${path}${path.includes("?") ? "&" : "?"}taskId=task&projectId=project`,
				{
					headers,
				},
			);
			socket.on("error", reject);
			socket.on("unexpected-response", (_request, response) => {
				response.resume();
				socket.terminate();
				resolve(response.statusCode ?? 0);
			});
			socket.on("open", () => {
				socket.close();
				resolve(101);
			});
		});
	}

	it("restricts notification presentation to an admitted desktop generation and exact runtime endpoint", async () => {
		const claim = "?notificationPresentation=desktop&notificationOnly=true";
		const headers = { ...desktopHeaders(), "x-quarterdeck-runtime-generation": descriptor.generation };
		expect(await upgrade(`/api/runtime/ws${claim}`, headers)).toBe(101);
		expect(await upgrade(`/api/runtime/ws${claim}`, { cookie: await bootstrapBrowser(), origin })).toBe(401);
		expect(await upgrade(`/api/runtime/ws${claim}`, desktopHeaders())).toBe(401);
		expect(
			await upgrade(`/api/runtime/ws${claim}`, { ...headers, "x-quarterdeck-runtime-generation": randomUUID() }),
		).toBe(401);
		expect(await upgrade(`/api/terminal/io${claim}`, headers)).toBe(401);
		expect(await upgrade(`/api/runtime/ws${claim}&notificationOnly=true`, headers)).toBe(401);
		expect(await upgrade("/api/runtime/ws?notificationOnly=true", headers)).toBe(401);
	});

	beforeEach(async () => {
		now = Date.now();
		clientCalls = 0;
		desktopToken = randomBytes(32).toString("base64url");
		managementToken = randomBytes(32).toString("base64url");
		descriptor = {
			version: 1,
			generation: randomUUID(),
			canonicalStateHome: "/synthetic/quarterdeck",
			process: { pid: process.pid, creationIdentity: "synthetic" },
			status: "ready",
			endpoint: null,
			quarterdeckVersion: "test",
			runtimeProtocolVersion: 4,
			managementProtocolVersion: 1,
			capabilities: {
				transportVersion: 1,
				browserHttp: true,
				browserWebSocket: true,
				desktopProxy: true,
				desktopBridgeVersion: 1,
			},
			startedAt: new Date(now).toISOString(),
			readyAt: new Date(now).toISOString(),
		};
		access = new RuntimeClientAccess({
			generation: descriptor.generation,
			now: () => now,
			management: {
				getPublicDescriptor: () => descriptor,
				verifyManagementToken: (token, generation) =>
					token === managementToken && generation === descriptor.generation,
			},
		});
		access.registerDesktopClient(desktopToken);
		openProject = vi.fn(async () => ({ projectId: "opened-project" }));
		sockets = new WebSocketServer({ noServer: true });
		server = createServer(async (request, response) => {
			if (handleHttpRequest(request, response, true).end) return;
			const url = new URL(request.url ?? "/", origin);
			if (await access.handleHttpRequest(request, response, url, openProject)) return;
			if (url.pathname.startsWith("/api/trpc/") && url.pathname !== "/api/trpc/hooks.ingest") clientCalls++;
			response.writeHead(200);
			response.end("passed-to-existing-handler");
		});
		server.on("upgrade", (request, socket, head) => {
			const admittedRequest = request as UpgradeRequest;
			if (
				handleSocketUpgrade(request, socket, true).end ||
				access.handleSocketUpgrade(request, socket, new URL(request.url ?? "/", origin))
			) {
				admittedRequest.__quarterdeckUpgradeHandled = true;
				return;
			}
			admittedRequest.__quarterdeckUpgradeAdmitted = true;
			if (new URL(request.url ?? "/", origin).pathname !== "/api/runtime/ws") return;
			admittedRequest.__quarterdeckUpgradeHandled = true;
			sockets.handleUpgrade(request, socket, head, (websocket) => sockets.emit("connection", websocket));
		});
		const terminalManager: TerminalSessionService = {
			attach: () => () => {},
			getRestoreSnapshot: async () => null,
			recoverStaleSession: () => null,
			writeInput: () => null,
			resize: () => true,
			pauseOutput: () => true,
			resumeOutput: () => true,
			stopTaskSession: () => null,
		};
		terminalBridge = createTerminalWebSocketBridge({
			server,
			resolveTerminalManager: () => terminalManager,
			isTerminalIoWebSocketPath: (path) => path === "/api/terminal/io",
			isTerminalControlWebSocketPath: (path) => path === "/api/terminal/control",
		});
		await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
		const address = server.address();
		if (!address || typeof address === "string") throw new Error("Test server needs a port.");
		setQuarterdeckRuntimeHost("127.0.0.1");
		setQuarterdeckRuntimePort(address.port);
		origin = `http://127.0.0.1:${address.port}`;
		descriptor.endpoint = { host: "127.0.0.1", port: address.port };
	});

	afterEach(async () => {
		access.clear();
		await terminalBridge.close();
		for (const socket of sockets.clients) socket.terminate();
		await new Promise<void>((resolve) => sockets.close(() => resolve()));
		await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
		setQuarterdeckRuntimeHost(originalHost);
		setQuarterdeckRuntimePort(originalPort);
	});

	it("rejects unauthenticated API calls before their existing handlers", async () => {
		const result = await send("/api/trpc/projects.list");
		expect(result.status).toBe(401);
		expect(JSON.parse(result.body)).toMatchObject({ code: "QUARTERDECK_CLIENT_ACCESS_REQUIRED" });
		expect(clientCalls).toBe(0);
	});

	it.each(["/api/runtime/ws", "/api/terminal/io", "/api/terminal/control"])(
		"requires client credentials for %s",
		async (path) => {
			expect(await upgrade(path, { origin })).toBe(401);
			expect(await upgrade(path, desktopHeaders())).toBe(101);
		},
	);

	it("admits desktop API requests only with its token, app origin and pinned host/port", async () => {
		expect((await send("/api/trpc/projects.list", desktopHeaders())).status).toBe(200);
		expect((await send("/api/trpc/projects.list", { ...desktopHeaders(), origin })).status).toBe(401);
		expect((await send("/api/trpc/projects.list", { ...desktopHeaders(), origin: "app://evil" })).status).toBe(403);
		expect((await send("/api/trpc/projects.list", { ...desktopHeaders(), host: "127.0.0.1:1" })).status).toBe(403);
		expect(
			(
				await send("/api/trpc/projects.list", {
					...desktopHeaders(),
					host: `localhost:${getQuarterdeckRuntimePort()}`,
				})
			).status,
		).toBe(401);
		expect((await send("/api/trpc/projects.list", { origin: "app://quarterdeck" })).status).toBe(401);
	});

	it("exchanges a single-use browser capability for an HttpOnly cookie and strips it on redirect", async () => {
		const path = access.createBrowserBootstrap("/project-a?view=git#task");
		const response = await send(path);
		expect(response.status).toBe(303);
		expect(response.headers.location).toBe("/project-a?view=git#task");
		expect(response.headers["referrer-policy"]).toBe("no-referrer");
		const setCookie = response.headers["set-cookie"]?.[0] ?? "";
		expect(setCookie).toContain("HttpOnly; SameSite=Strict; Path=/; Max-Age=86400");
		const cookie = setCookie.split(";")[0] ?? "";
		expect((await send("/api/trpc/projects.list", { cookie })).status).toBe(200);
		expect((await send(path)).status).toBe(401);
	});

	it.each(["/api/runtime/ws", "/api/terminal/io", "/api/terminal/control"])(
		"admits browser cookies for %s with the runtime origin",
		async (path) => {
			const cookie = await bootstrapBrowser();
			expect(await upgrade(path, { cookie, origin })).toBe(101);
			expect(await upgrade(path, { cookie })).toBe(401);
			expect(await upgrade(path, { cookie, origin: "http://evil.test" })).toBe(403);
		},
	);

	it("requires an admitted Origin and JSON for browser mutations", async () => {
		const cookie = await bootstrapBrowser();
		const path = "/api/trpc/runtime.saveConfig";
		expect((await send(path, { cookie }, "POST", {})).status).toBe(401);
		expect((await send(path, { cookie, origin, "content-type": "text/plain" }, "POST", {})).status).toBe(401);
		expect(
			(await send(path, { cookie, origin: "http://evil.test", "content-type": "application/json" }, "POST", {}))
				.status,
		).toBe(403);
		expect((await send(path, { cookie, origin, "content-type": "application/json" }, "POST", {})).status).toBe(200);
	});

	it("rejects duplicate cookies and keeps management/desktop credentials out of browser scope", async () => {
		const cookie = await bootstrapBrowser();
		expect((await send("/api/trpc/projects.list", { cookie: `${cookie}; ${cookie}` })).status).toBe(401);
		expect((await send("/api/trpc/projects.list", { authorization: `Bearer ${managementToken}` })).status).toBe(401);
		expect(
			(
				await send("/api/trpc/projects.list", {
					cookie: `quarterdeck_client_${descriptor.generation}=${desktopToken}`,
				})
			).status,
		).toBe(401);
	});

	it("expires browser credentials while desktop admission lasts until generation change or shutdown", async () => {
		const cookie = await bootstrapBrowser();
		const bootstrapPath = access.createBrowserBootstrap();
		now += 60_001;
		expect((await send(bootstrapPath)).status).toBe(401);
		now += 24 * 60 * 60 * 1_000;
		expect((await send("/api/trpc/projects.list", { cookie })).status).toBe(401);
		expect((await send("/api/trpc/projects.list", desktopHeaders())).status).toBe(200);
		access.registerDesktopClient(desktopToken);
		descriptor = { ...descriptor, generation: randomUUID() };
		expect((await send("/api/trpc/projects.list", desktopHeaders())).status).toBe(401);
	});

	it("keeps cookies for separate runtime generations on one host across different ports", async () => {
		const otherDescriptor: PublicRuntimeOwnerDescriptor = {
			...descriptor,
			generation: randomUUID(),
			canonicalStateHome: "/synthetic/dogfood",
		};
		const otherAccess = new RuntimeClientAccess({
			generation: otherDescriptor.generation,
			management: { getPublicDescriptor: () => otherDescriptor, verifyManagementToken: () => false },
		});
		const otherServer = createServer(async (request, response) => {
			// Isolate cookie admission here; the other cases cover the host/origin gates.
			if (await otherAccess.handleHttpRequest(request, response, new URL(request.url ?? "/", "http://127.0.0.1")))
				return;
			response.writeHead(200);
			response.end("other-runtime");
		});
		await new Promise<void>((resolve) => otherServer.listen(0, "127.0.0.1", resolve));
		try {
			const address = otherServer.address();
			if (!address || typeof address === "string") throw new Error("Expected second runtime port.");
			const otherOrigin = `http://127.0.0.1:${address.port}`;
			expect(otherOrigin).not.toBe(origin);
			const firstCookie = await bootstrapBrowser();
			const response = await send(otherAccess.createBrowserBootstrap(), {}, "GET", undefined, otherOrigin);
			const secondCookie = response.headers["set-cookie"]?.[0]?.split(";")[0] ?? "";
			expect(secondCookie.split("=")[0]).not.toBe(firstCookie.split("=")[0]);
			const cookieJar = `${firstCookie}; ${secondCookie}`;
			expect((await send("/api/trpc/projects.list", { cookie: cookieJar })).status).toBe(200);
			expect(
				(await send("/api/trpc/projects.list", { cookie: cookieJar }, "GET", undefined, otherOrigin)).status,
			).toBe(200);
			otherAccess.clear();
			expect((await send("/api/trpc/projects.list", { cookie: cookieJar })).status).toBe(200);
		} finally {
			otherAccess.clear();
			await new Promise<void>((resolve) => otherServer.close(() => resolve()));
		}
	});

	it.each([
		"browser-records",
		"browser-snapshot",
		"browser-status",
		"browser-subscription",
		"browser-export",
		"browser-record",
	])("requires client access before the independent %s diagnostic capability gate", async (route) => {
		const path = `/api/diagnostics/${route}`;
		expect((await send(path)).status).toBe(401);
		expect((await send(path, desktopHeaders())).body).toBe("passed-to-existing-handler");
	});

	it("authenticates management status with an independent token and exact generation", async () => {
		expect((await send("/api/management/status")).status).toBe(401);
		expect(
			(
				await send("/api/management/status", {
					...managementHeaders(),
					"x-quarterdeck-runtime-generation": randomUUID(),
				})
			).status,
		).toBe(401);
		expect((await send("/api/management/status", { ...managementHeaders(), origin })).status).toBe(401);
		const result = await send("/api/management/status", managementHeaders());
		expect(result.status).toBe(200);
		expect(JSON.parse(result.body)).toEqual({ descriptor });
		expect(result.body).not.toContain(managementToken);
	});

	it("enrolls desktop credentials and issues browser capabilities through generation-checked management", async () => {
		const newToken = randomBytes(32).toString("base64url");
		const path = "/api/management/client-bootstrap";
		const input = {
			generation: descriptor.generation,
			kind: "desktop",
			clientToken: newToken,
			origin: "app://quarterdeck",
		};
		expect((await send(path, managementHeaders(), "POST", { ...input, generation: randomUUID() })).status).toBe(401);
		expect((await send(path, managementHeaders(), "POST", { ...input, origin: "app://evil" })).status).toBe(400);
		expect((await send(path, managementHeaders(), "POST", input)).status).toBe(200);
		expect(
			(await send("/api/trpc/projects.list", { ...desktopHeaders(), "x-quarterdeck-desktop-token": newToken }))
				.status,
		).toBe(200);
		const result = await send(path, managementHeaders(), "POST", {
			generation: descriptor.generation,
			kind: "browser",
			returnPath: "/project-a",
		});
		const body = JSON.parse(result.body) as { generation: string; bootstrapPath: string };
		expect(body.generation).toBe(descriptor.generation);
		expect((await send(body.bootstrapPath)).status).toBe(303);
	});

	it("refuses enrollment when ready capabilities do not support desktop clients", async () => {
		descriptor.capabilities.desktopProxy = false;
		const result = await send("/api/management/client-bootstrap", managementHeaders(), "POST", {
			generation: descriptor.generation,
			kind: "desktop",
			clientToken: desktopToken,
			origin: "app://quarterdeck",
		});
		expect(result.status).toBe(409);
	});

	it("routes only the authenticated typed project-open intent to the existing project owner", async () => {
		const path = "/api/management/projects/open";
		const body = { generation: descriptor.generation, projectPath: "/synthetic/project" };
		expect((await send(path, {}, "POST", body)).status).toBe(401);
		expect(openProject).not.toHaveBeenCalled();
		expect((await send(path, managementHeaders(), "POST", body)).status).toBe(200);
		expect(openProject).toHaveBeenCalledOnce();
		expect(openProject).toHaveBeenCalledWith("/synthetic/project");
		expect(
			(await send("/api/management/quit", managementHeaders(), "POST", { generation: descriptor.generation }))
				.status,
		).toBe(404);
	});

	it("leaves static assets, diagnostics and exact native hook ingest with their independent handlers", async () => {
		for (const path of ["/", "/assets/main.js", "/api/diagnostics/status"]) {
			expect((await send(path)).body).toBe("passed-to-existing-handler");
		}
		expect((await send("/api/trpc/hooks.ingest?batch=1", {}, "POST", {})).body).toBe("passed-to-existing-handler");
		expect((await send("/api/trpc/hooks.ingest,runtime.saveConfig?batch=1", {}, "POST", {})).status).toBe(401);
	});

	it.each([
		"https://evil.test",
		"//evil.test",
		"/\\evil.test",
		"/api/trpc/projects.list",
		"/%61pi/trpc",
		"/../api/trpc",
	])("rejects unsafe browser return path %s", (path) => {
		expect(() => access.createBrowserBootstrap(path)).toThrow("Invalid browser return path");
	});

	it("revokes already admitted sockets on explicit access shutdown", async () => {
		const socket = new WebSocket(`${origin.replace("http:", "ws:")}/api/terminal/io?taskId=task&projectId=project`, {
			headers: desktopHeaders(),
		});
		await once(socket, "open");
		const closed = once(socket, "close");
		access.clear();
		await closed;
		expect((await send("/api/trpc/projects.list", desktopHeaders())).status).toBe(401);
	});

	it("releases desktop attachment slots across more than 128 enroll/revoke cycles", async () => {
		for (let index = 0; index < 140; index++) {
			const token = randomBytes(32).toString("base64url");
			access.registerDesktopClient(token);
			const result = await send("/api/management/client-revoke", managementHeaders(), "POST", {
				generation: descriptor.generation,
				kind: "desktop",
				clientToken: token,
			});
			expect(result.status).toBe(200);
		}
		expect((await send("/api/trpc/projects.list", desktopHeaders())).status).toBe(200);
	});

	it("revokes only the selected current-generation desktop client and its sockets", async () => {
		const otherToken = randomBytes(32).toString("base64url");
		access.registerDesktopClient(otherToken);
		const browserCookie = await bootstrapBrowser();
		const socket = new WebSocket(`${origin.replace("http:", "ws:")}/api/runtime/ws`, { headers: desktopHeaders() });
		await once(socket, "open");
		const body = { generation: descriptor.generation, kind: "desktop", clientToken: desktopToken };
		const path = "/api/management/client-revoke";
		expect((await send(path, desktopHeaders(), "POST", body)).status).toBe(401);
		expect((await send(path, managementHeaders(), "POST", { ...body, generation: randomUUID() })).status).toBe(401);
		expect((await send("/api/trpc/projects.list", desktopHeaders())).status).toBe(200);
		const closed = once(socket, "close");
		expect((await send(path, managementHeaders(), "POST", body)).status).toBe(200);
		await closed;
		expect((await send("/api/trpc/projects.list", desktopHeaders())).status).toBe(401);
		expect(
			(await send("/api/trpc/projects.list", { ...desktopHeaders(), "x-quarterdeck-desktop-token": otherToken }))
				.status,
		).toBe(200);
		expect((await send("/api/trpc/projects.list", { cookie: browserCookie })).status).toBe(200);
		expect((await send(path, managementHeaders(), "POST", body)).status).toBe(200);
	});
});
