import { randomBytes, randomUUID } from "node:crypto";
import { once } from "node:events";
import { createServer, request as httpRequest, type IncomingHttpHeaders, type Server } from "node:http";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WebSocket, WebSocketServer } from "ws";
import type { PublicRuntimeOwnerDescriptor } from "../../src/core/api/runtime-management";
import { QUARTERDECK_RUNTIME_PROTOCOL_VERSION } from "../../src/core/api/runtime-protocol";
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

describe("desktop-only runtime client admission over HTTP and WebSocket upgrades", () => {
	const originalHost = getQuarterdeckRuntimeHost();
	const originalPort = getQuarterdeckRuntimePort();
	let server: Server;
	let sockets: WebSocketServer;
	let terminalBridge: TerminalWebSocketBridge;
	let access: RuntimeClientAccess;
	let origin: string;
	let descriptor: PublicRuntimeOwnerDescriptor;
	let desktopToken: string;
	let managementToken: string;
	let clientCalls: number;
	let openProject: ReturnType<typeof vi.fn<(path: string) => Promise<{ projectId: string }>>>;

	function send(
		path: string,
		headers: Record<string, string> = {},
		method = "GET",
		body?: unknown,
	): Promise<HttpResult> {
		return new Promise((resolve, reject) => {
			const request = httpRequest(`${origin}${path}`, { method, headers }, (response) => {
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

	function legacyCookie(): string {
		return `quarterdeck_client_${descriptor.generation}=${desktopToken}`;
	}

	function upgrade(path: string, headers: Record<string, string>): Promise<number> {
		return new Promise((resolve, reject) => {
			const socket = new WebSocket(
				`${origin.replace("http:", "ws:")}${path}${path.includes("?") ? "&" : "?"}taskId=task&projectId=project`,
				{ headers },
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

	beforeEach(async () => {
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
			runtimeProtocolVersion: QUARTERDECK_RUNTIME_PROTOCOL_VERSION,
			managementProtocolVersion: 1,
			capabilities: { transportVersion: 1, desktopProxy: true, desktopBridgeVersion: 1 },
			startedAt: new Date().toISOString(),
			readyAt: new Date().toISOString(),
		};
		access = new RuntimeClientAccess({
			generation: descriptor.generation,
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

	it.each([
		"/api/trpc/projects.list",
		"/",
		"/index.html",
		"/project-a",
		"/assets/main.js",
		"/api/agent-lab/host-events",
	])("rejects unauthenticated and browser-cookie access to %s before existing handlers", async (path) => {
		const deniedHeaders: Record<string, string>[] = [
			{},
			{ cookie: legacyCookie() },
			{ origin, cookie: legacyCookie() },
		];
		for (const headers of deniedHeaders) {
			const result = await send(path, headers);
			expect(result.status).toBe(401);
			expect(result.headers["set-cookie"]).toBeUndefined();
		}
		expect(clientCalls).toBe(0);
	});

	it("does not exchange removed browser bootstrap capabilities or enroll browsers through management", async () => {
		const result = await send(`/api/runtime/client-bootstrap?capability=${desktopToken}`);
		expect(result.status).toBe(401);
		expect(result.headers["set-cookie"]).toBeUndefined();
		expect(result.headers.location).toBeUndefined();
		expect(
			(
				await send("/api/management/client-bootstrap", managementHeaders(), "POST", {
					generation: descriptor.generation,
					kind: "browser",
					returnPath: "/project-a",
				})
			).status,
		).toBe(400);
	});

	it.each(["/api/runtime/ws", "/api/terminal/io", "/api/terminal/control"])(
		"admits only desktop credentials for %s",
		async (path) => {
			const deniedHeaders: Record<string, string>[] = [
				{},
				{ origin },
				{ cookie: legacyCookie(), origin },
				{ authorization: `Bearer ${managementToken}` },
			];
			for (const headers of deniedHeaders) expect(await upgrade(path, headers)).toBe(401);
			expect(await upgrade(path, desktopHeaders())).toBe(101);
		},
	);

	it.each(["/api%252fruntime/ws", "/api%252fterminal/io", "/api%252fterminal/control", "/unknown"])(
		"never passes an unauthenticated unknown or doubly-encoded upgrade %s to downstream routing",
		async (path) => {
			expect(await upgrade(path, {})).toBe(401);
			expect(await upgrade(path, desktopHeaders())).toBe(401);
		},
	);

	it("admits desktop API requests only with its token, app origin and pinned host/port", async () => {
		expect((await send("/api/trpc/projects.list", desktopHeaders())).status).toBe(200);
		expect(
			(
				await send(
					"/api/trpc/runtime.saveConfig",
					{ ...desktopHeaders(), "content-type": "application/json" },
					"POST",
					{},
				)
			).status,
		).toBe(200);
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
		expect((await send("/api/trpc/projects.list", { authorization: `Bearer ${managementToken}` })).status).toBe(401);
	});

	it("restricts notification presentation to an admitted desktop generation and exact runtime endpoint", async () => {
		const claim = "?notificationPresentation=desktop&notificationOnly=true";
		const headers = { ...desktopHeaders(), "x-quarterdeck-runtime-generation": descriptor.generation };
		expect(await upgrade(`/api/runtime/ws${claim}`, headers)).toBe(101);
		expect(await upgrade(`/api/runtime/ws${claim}`, { cookie: legacyCookie(), origin })).toBe(401);
		expect(await upgrade(`/api/runtime/ws${claim}`, desktopHeaders())).toBe(401);
		expect(
			await upgrade(`/api/runtime/ws${claim}`, { ...headers, "x-quarterdeck-runtime-generation": randomUUID() }),
		).toBe(401);
		expect(await upgrade(`/api/terminal/io${claim}`, headers)).toBe(401);
		expect(await upgrade(`/api/runtime/ws${claim}&notificationOnly=true`, headers)).toBe(401);
		expect(await upgrade("/api/runtime/ws?notificationOnly=true", headers)).toBe(401);
	});

	it("keeps desktop admission until revocation but refuses a changed runtime generation", async () => {
		access.registerDesktopClient(desktopToken);
		expect((await send("/api/trpc/projects.list", desktopHeaders())).status).toBe(200);
		descriptor = { ...descriptor, generation: randomUUID() };
		expect((await send("/api/trpc/projects.list", desktopHeaders())).status).toBe(401);
	});

	it.each([
		"browser-records",
		"browser-snapshot",
		"browser-status",
		"browser-subscription",
		"browser-export",
		"browser-record",
	])("retains desktop admission ahead of the independent renderer %s diagnostic capability gate", async (route) => {
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

	it("enrolls desktop credentials only through generation-checked management", async () => {
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
	});

	it("refuses enrollment when ready capabilities do not support desktop clients", async () => {
		descriptor.capabilities.desktopProxy = false;
		expect(
			(
				await send("/api/management/client-bootstrap", managementHeaders(), "POST", {
					generation: descriptor.generation,
					kind: "desktop",
					clientToken: desktopToken,
					origin: "app://quarterdeck",
				})
			).status,
		).toBe(409);
	});

	it("routes only authenticated typed project-open intent to the existing project owner", async () => {
		const path = "/api/management/projects/open";
		const body = { generation: descriptor.generation, projectPath: "/synthetic/project" };
		expect((await send(path, {}, "POST", body)).status).toBe(401);
		expect(openProject).not.toHaveBeenCalled();
		expect((await send(path, managementHeaders(), "POST", body)).status).toBe(200);
		expect(openProject).toHaveBeenCalledExactlyOnceWith("/synthetic/project");
		expect(
			(await send("/api/management/quit", managementHeaders(), "POST", { generation: descriptor.generation }))
				.status,
		).toBe(404);
	});

	it("leaves command diagnostics and exact native hook routes with their independent authentication", async () => {
		for (const path of ["/api/diagnostics/status", "/api/diagnostics/records", "/api/hooks/notify"])
			expect((await send(path)).body).toBe("passed-to-existing-handler");
		expect((await send("/api/trpc/hooks.ingest?batch=1", {}, "POST", {})).body).toBe("passed-to-existing-handler");
		expect((await send("/api/trpc/hooks.ingest", {}, "GET")).status).toBe(401);
		expect((await send("/api/trpc/hooks.ingest,runtime.saveConfig?batch=1", {}, "POST", {})).status).toBe(401);
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
			expect(
				(
					await send("/api/management/client-revoke", managementHeaders(), "POST", {
						generation: descriptor.generation,
						kind: "desktop",
						clientToken: token,
					})
				).status,
			).toBe(200);
		}
		expect((await send("/api/trpc/projects.list", desktopHeaders())).status).toBe(200);
	});

	it("revokes only the selected current-generation desktop client and its sockets", async () => {
		const otherToken = randomBytes(32).toString("base64url");
		access.registerDesktopClient(otherToken);
		const socket = new WebSocket(`${origin.replace("http:", "ws:")}/api/runtime/ws`, { headers: desktopHeaders() });
		await once(socket, "open");
		const body = { generation: descriptor.generation, kind: "desktop", clientToken: desktopToken };
		const path = "/api/management/client-revoke";
		expect((await send(path, desktopHeaders(), "POST", body)).status).toBe(401);
		expect((await send(path, managementHeaders(), "POST", { ...body, generation: randomUUID() })).status).toBe(401);
		const closed = once(socket, "close");
		expect((await send(path, managementHeaders(), "POST", body)).status).toBe(200);
		await closed;
		expect((await send("/api/trpc/projects.list", desktopHeaders())).status).toBe(401);
		expect(
			(await send("/api/trpc/projects.list", { ...desktopHeaders(), "x-quarterdeck-desktop-token": otherToken }))
				.status,
		).toBe(200);
		expect((await send(path, managementHeaders(), "POST", body)).status).toBe(200);
	});
});
