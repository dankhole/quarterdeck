import { randomBytes, timingSafeEqual } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { Duplex } from "node:stream";
import { z } from "zod";
import { QUARTERDECK_DESKTOP_ORIGIN, QUARTERDECK_DESKTOP_TOKEN_HEADER } from "../core/api/desktop-runtime-protocol";
import {
	type PublicRuntimeOwnerDescriptor,
	RUNTIME_MANAGEMENT_GENERATION_HEADER,
	type RuntimeManagementProjectOpenResponse,
	runtimeManagementProjectOpenRequestSchema,
} from "../core/api/runtime-management";
import { getQuarterdeckRuntimePort } from "../core/runtime-endpoint";
import { getAllowedRuntimeOrigins } from "./middleware";

const CLIENT_TOKEN = /^[A-Za-z0-9_-]{43,128}$/;
const MAX_CREDENTIALS = 128;
const DEFAULT_CLIENT_TTL_MS = 24 * 60 * 60 * 1_000;
const DEFAULT_BOOTSTRAP_TTL_MS = 60_000;
const BOOTSTRAP_PATH = "/api/runtime/client-bootstrap";
const MANAGEMENT_PREFIX = "/api/management/";
const SOCKET_PATHS = new Set(["/api/runtime/ws", "/api/terminal/io", "/api/terminal/control"]);
const BROWSER_DIAGNOSTIC_PATHS = new Set([
	"/api/diagnostics/browser-records",
	"/api/diagnostics/browser-snapshot",
	"/api/diagnostics/browser-status",
	"/api/diagnostics/browser-subscription",
	"/api/diagnostics/browser-export",
	"/api/diagnostics/browser-record",
]);

const enrollmentSchema = z.discriminatedUnion("kind", [
	z.object({ generation: z.string().uuid(), kind: z.literal("browser"), returnPath: z.string().optional() }).strict(),
	z
		.object({
			generation: z.string().uuid(),
			kind: z.literal("desktop"),
			clientToken: z.string().regex(CLIENT_TOKEN),
			origin: z.literal(QUARTERDECK_DESKTOP_ORIGIN),
		})
		.strict(),
]);
const revocationSchema = z
	.object({ generation: z.string().uuid(), kind: z.literal("desktop"), clientToken: z.string().regex(CLIENT_TOKEN) })
	.strict();

interface Credential {
	expiresAt: number;
}

export interface RuntimeClientAccessOptions {
	generation: string;
	management: {
		getPublicDescriptor: () => PublicRuntimeOwnerDescriptor | null;
		verifyManagementToken: (token: string, generation: string) => boolean;
	};
	now?: () => number;
	clientTtlMs?: number;
	bootstrapTtlMs?: number;
}

function header(request: IncomingMessage, name: string): string | undefined {
	const value = request.headers[name];
	return typeof value === "string" ? value : undefined;
}

function isLoopback(address: string | undefined): boolean {
	return address === "127.0.0.1" || address === "::1" || address === "::ffff:127.0.0.1";
}

function matchesToken(actual: string, expected: string): boolean {
	const actualBytes = Buffer.from(actual);
	const expectedBytes = Buffer.from(expected);
	return actualBytes.length === expectedBytes.length && timingSafeEqual(actualBytes, expectedBytes);
}

function respond(response: ServerResponse, status: number, body: unknown): true {
	response.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
	response.end(JSON.stringify(body));
	return true;
}

function rejectAccess(response: ServerResponse): true {
	return respond(response, 401, {
		error: "Runtime client access expired or is unavailable. Open Quarterdeck again from the CLI or desktop app.",
		code: "QUARTERDECK_CLIENT_ACCESS_REQUIRED",
	});
}

function validateReturnPath(path: string): string {
	if (
		path.length > 4_096 ||
		!path.startsWith("/") ||
		path.startsWith("//") ||
		path.includes("\\") ||
		[...path].some((character) => character.charCodeAt(0) < 32) ||
		path.startsWith("/api/")
	) {
		throw new Error("Invalid browser return path.");
	}
	const url = new URL(path, "http://quarterdeck.invalid");
	if (url.origin !== "http://quarterdeck.invalid" || decodeURIComponent(url.pathname).startsWith("/api/")) {
		throw new Error("Invalid browser return path.");
	}
	return `${url.pathname}${url.search}${url.hash}`;
}

async function readJson(request: IncomingMessage): Promise<unknown> {
	if (!header(request, "content-type")?.toLowerCase().startsWith("application/json")) {
		throw new Error("Expected JSON.");
	}
	const chunks: Buffer[] = [];
	let size = 0;
	for await (const chunk of request) {
		const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
		size += bytes.length;
		if (size > 4_096) throw new Error("Request too large.");
		chunks.push(bytes);
	}
	return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
}

/** Per-generation client admission. Management, desktop and browser credentials have separate scopes. */
export class RuntimeClientAccess {
	readonly generation: string;
	private readonly cookieName: string;
	private readonly now: () => number;
	private readonly clientTtlMs: number;
	private readonly bootstrapTtlMs: number;
	private readonly desktopClients = new Map<string, Credential>();
	private readonly browserClients = new Map<string, Credential>();
	private readonly bootstrapCapabilities = new Map<string, Credential & { returnPath: string }>();
	private readonly socketTimers = new Map<Duplex, { timer: NodeJS.Timeout | null; credential: Credential }>();
	private readonly desktopSocketRequests = new WeakSet<IncomingMessage>();
	private cleared = false;

	constructor(private readonly options: RuntimeClientAccessOptions) {
		this.generation = z.string().uuid().parse(options.generation);
		// Cookies have no port scope. Different state homes on this loopback host must coexist.
		this.cookieName = `quarterdeck_client_${this.generation}`;
		this.now = options.now ?? Date.now;
		this.clientTtlMs = options.clientTtlMs ?? DEFAULT_CLIENT_TTL_MS;
		this.bootstrapTtlMs = options.bootstrapTtlMs ?? DEFAULT_BOOTSTRAP_TTL_MS;
		if (
			!Number.isFinite(this.clientTtlMs) ||
			this.clientTtlMs <= 0 ||
			!Number.isFinite(this.bootstrapTtlMs) ||
			this.bootstrapTtlMs <= 0
		) {
			throw new Error("Client credential lifetimes must be positive finite values.");
		}
	}

	registerDesktopClient(token: string): void {
		if (this.cleared || !CLIENT_TOKEN.test(token)) throw new Error("Invalid desktop client credential.");
		this.prune(this.desktopClients);
		if (!this.desktopClients.has(token) && this.desktopClients.size >= MAX_CREDENTIALS) {
			throw new Error("Desktop client admission capacity reached.");
		}
		if (!this.desktopClients.has(token)) this.desktopClients.set(token, { expiresAt: Number.POSITIVE_INFINITY });
	}

	revokeDesktopClient(token: string): void {
		const credential = this.findCredential(this.desktopClients, token);
		if (!credential) return;
		this.desktopClients.delete(token);
		for (const [socket, tracked] of this.socketTimers) {
			if (tracked.credential !== credential) continue;
			if (tracked.timer) clearTimeout(tracked.timer);
			socket.destroy();
			this.socketTimers.delete(socket);
		}
	}

	createBrowserBootstrap(returnPath = "/"): string {
		if (this.cleared) throw new Error("Runtime client admission is closed.");
		const validatedPath = validateReturnPath(returnPath);
		this.prune(this.bootstrapCapabilities);
		if (this.bootstrapCapabilities.size >= MAX_CREDENTIALS) throw new Error("Browser bootstrap capacity reached.");
		const capability = randomBytes(32).toString("base64url");
		this.bootstrapCapabilities.set(capability, {
			expiresAt: this.now() + this.bootstrapTtlMs,
			returnPath: validatedPath,
		});
		return `${BOOTSTRAP_PATH}?capability=${capability}`;
	}

	clear(): void {
		this.cleared = true;
		this.desktopClients.clear();
		this.browserClients.clear();
		this.bootstrapCapabilities.clear();
		for (const [socket, tracked] of this.socketTimers) {
			if (tracked.timer) clearTimeout(tracked.timer);
			socket.destroy();
		}
		this.socketTimers.clear();
	}

	async handleHttpRequest(
		request: IncomingMessage,
		response: ServerResponse,
		url: URL,
		openProject?: (projectPath: string) => Promise<RuntimeManagementProjectOpenResponse>,
	): Promise<boolean> {
		if (url.pathname === BOOTSTRAP_PATH) return this.exchangeBrowserBootstrap(request, response, url);
		if (url.pathname.startsWith(MANAGEMENT_PREFIX))
			return await this.handleManagement(request, response, url, openProject);
		if (url.pathname === "/api/trpc/hooks.ingest" && request.method === "POST") return false;
		if (
			url.pathname !== "/api/trpc" &&
			!url.pathname.startsWith("/api/trpc/") &&
			!BROWSER_DIAGNOSTIC_PATHS.has(url.pathname)
		)
			return false;
		const credential = this.authorizeClient(request, false);
		return credential ? false : rejectAccess(response);
	}

	handleSocketUpgrade(request: IncomingMessage, socket: Duplex, url: URL): boolean {
		if (!SOCKET_PATHS.has(url.pathname)) return false;
		const credential = this.authorizeClient(request, true);
		const desktopCredential = this.findCredential(
			this.desktopClients,
			header(request, QUARTERDECK_DESKTOP_TOKEN_HEADER),
		);
		const presentationRequested =
			url.searchParams.has("notificationPresentation") || url.searchParams.has("notificationOnly");
		if (
			!credential ||
			(presentationRequested &&
				(credential !== desktopCredential ||
					header(request, "x-quarterdeck-runtime-generation") !== this.generation ||
					url.pathname !== "/api/runtime/ws" ||
					url.searchParams.getAll("notificationPresentation").length !== 1 ||
					url.searchParams.get("notificationPresentation") !== "desktop" ||
					url.searchParams.getAll("notificationOnly").length !== 1 ||
					url.searchParams.get("notificationOnly") !== "true"))
		) {
			socket.end("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\nCache-Control: no-store\r\n\r\n");
			return true;
		}
		if (credential === desktopCredential) this.desktopSocketRequests.add(request);
		const timer = Number.isFinite(credential.expiresAt)
			? setTimeout(() => socket.destroy(), Math.max(0, credential.expiresAt - this.now()))
			: null;
		timer?.unref();
		this.socketTimers.set(socket, { timer, credential });
		socket.once("close", () => {
			if (timer) clearTimeout(timer);
			this.socketTimers.delete(socket);
		});
		return false;
	}

	isDesktopSocketAdmitted(request: IncomingMessage): boolean {
		return this.desktopSocketRequests.has(request);
	}

	private isReady(): boolean {
		const descriptor = this.options.management.getPublicDescriptor();
		return !this.cleared && descriptor?.generation === this.generation && descriptor.status === "ready";
	}

	private prune(credentials: Map<string, Credential>): void {
		for (const [token, credential] of credentials) {
			if (credential.expiresAt <= this.now()) credentials.delete(token);
		}
	}

	private findCredential(credentials: Map<string, Credential>, token: string | undefined): Credential | null {
		if (!token || !CLIENT_TOKEN.test(token)) return null;
		this.prune(credentials);
		for (const [expected, credential] of credentials) {
			if (matchesToken(token, expected)) return credential;
		}
		return null;
	}

	private authorizeClient(request: IncomingMessage, websocket: boolean): Credential | null {
		if (!this.isReady() || (request.method !== "GET" && request.method !== "POST")) return null;
		const origin = header(request, "origin");
		const desktopToken = header(request, QUARTERDECK_DESKTOP_TOKEN_HEADER);
		if (desktopToken !== undefined || origin === QUARTERDECK_DESKTOP_ORIGIN) {
			if (
				origin !== QUARTERDECK_DESKTOP_ORIGIN ||
				header(request, "host") !== `127.0.0.1:${getQuarterdeckRuntimePort()}`
			)
				return null;
			return this.findCredential(this.desktopClients, desktopToken);
		}
		const allowedOrigins = getAllowedRuntimeOrigins();
		if ((origin !== undefined && !allowedOrigins.has(origin)) || (websocket && origin === undefined)) return null;
		if (
			request.method === "POST" &&
			(!origin ||
				!allowedOrigins.has(origin) ||
				!header(request, "content-type")?.toLowerCase().startsWith("application/json"))
		)
			return null;
		if (request.method !== "GET" && request.method !== "POST") return null;
		const cookies =
			header(request, "cookie")
				?.split(";")
				.map((part) => part.trim())
				.filter((part) => part.startsWith(`${this.cookieName}=`)) ?? [];
		if (cookies.length !== 1) return null;
		return this.findCredential(this.browserClients, cookies[0]?.slice(this.cookieName.length + 1));
	}

	private exchangeBrowserBootstrap(request: IncomingMessage, response: ServerResponse, url: URL): boolean {
		if (!this.isReady() || request.method !== "GET") return rejectAccess(response);
		const origin = header(request, "origin");
		if (origin !== undefined && !getAllowedRuntimeOrigins().has(origin)) return rejectAccess(response);
		const capabilities = url.searchParams.getAll("capability");
		if (capabilities.length !== 1 || [...url.searchParams.keys()].some((key) => key !== "capability"))
			return rejectAccess(response);
		this.prune(this.bootstrapCapabilities);
		this.prune(this.browserClients);
		const capability = capabilities[0];
		const bootstrap = capability ? this.bootstrapCapabilities.get(capability) : undefined;
		if (!capability || !bootstrap || this.browserClients.size >= MAX_CREDENTIALS) return rejectAccess(response);
		this.bootstrapCapabilities.delete(capability);
		const token = randomBytes(32).toString("base64url");
		this.browserClients.set(token, { expiresAt: this.now() + this.clientTtlMs });
		response.writeHead(303, {
			Location: bootstrap.returnPath,
			"Set-Cookie": `${this.cookieName}=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${Math.floor(this.clientTtlMs / 1_000)}`,
			"Cache-Control": "no-store",
			"Referrer-Policy": "no-referrer",
		});
		response.end();
		return true;
	}

	private async handleManagement(
		request: IncomingMessage,
		response: ServerResponse,
		url: URL,
		openProject?: (projectPath: string) => Promise<RuntimeManagementProjectOpenResponse>,
	): Promise<boolean> {
		const generation = header(request, RUNTIME_MANAGEMENT_GENERATION_HEADER);
		const authorization = header(request, "authorization");
		const token = authorization?.startsWith("Bearer ") ? authorization.slice(7) : undefined;
		if (
			this.cleared ||
			!isLoopback(request.socket.remoteAddress) ||
			header(request, "origin") !== undefined ||
			generation !== this.generation ||
			!token ||
			!this.options.management.verifyManagementToken(token, generation)
		)
			return rejectAccess(response);
		const descriptor = this.options.management.getPublicDescriptor();
		if (!descriptor || descriptor.generation !== generation) return rejectAccess(response);
		if (url.pathname === "/api/management/status" && request.method === "GET")
			return respond(response, 200, { descriptor });
		if (!this.isReady() || request.method !== "POST")
			return respond(response, 409, { error: "Runtime is not ready for client attachment." });
		try {
			if (url.pathname === "/api/management/client-revoke") {
				const input = revocationSchema.parse(await readJson(request));
				if (input.generation !== this.generation) return rejectAccess(response);
				this.revokeDesktopClient(input.clientToken);
				return respond(response, 200, { generation: this.generation, revoked: true });
			}
			if (url.pathname === "/api/management/client-bootstrap") {
				const input = enrollmentSchema.parse(await readJson(request));
				if (input.generation !== this.generation) return rejectAccess(response);
				if (input.kind === "desktop") {
					if (!descriptor.capabilities.desktopProxy || descriptor.capabilities.desktopBridgeVersion !== 1)
						return respond(response, 409, { error: "Runtime does not support desktop attachment." });
					this.registerDesktopClient(input.clientToken);
					return respond(response, 200, { generation: this.generation, enrolled: true });
				}
				if (!descriptor.capabilities.browserHttp || !descriptor.capabilities.browserWebSocket)
					return respond(response, 409, { error: "Runtime does not support browser attachment." });
				return respond(response, 200, {
					generation: this.generation,
					bootstrapPath: this.createBrowserBootstrap(input.returnPath),
				});
			}
			if (url.pathname === "/api/management/projects/open" && openProject) {
				const input = runtimeManagementProjectOpenRequestSchema.strict().parse(await readJson(request));
				if (input.generation !== this.generation) return rejectAccess(response);
				return respond(response, 200, await openProject(input.projectPath));
			}
			return respond(response, 404, { error: "Management route not found." });
		} catch {
			return respond(response, 400, { error: "Invalid client attachment request." });
		}
	}
}
