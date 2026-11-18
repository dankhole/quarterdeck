import { timingSafeEqual } from "node:crypto";
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

const CLIENT_TOKEN = /^[A-Za-z0-9_-]{43,128}$/;
const MAX_CREDENTIALS = 128;
const MANAGEMENT_PREFIX = "/api/management/";
const SOCKET_PATHS = new Set(["/api/runtime/ws", "/api/terminal/io", "/api/terminal/control"]);
// These are renderer diagnostics, including inside Electron, not standalone-browser admission.
const RENDERER_DIAGNOSTIC_PATHS = new Set([
	"/api/diagnostics/browser-records",
	"/api/diagnostics/browser-snapshot",
	"/api/diagnostics/browser-status",
	"/api/diagnostics/browser-subscription",
	"/api/diagnostics/browser-export",
	"/api/diagnostics/browser-record",
]);

const enrollmentSchema = z.strictObject({
	generation: z.string().uuid(),
	kind: z.literal("desktop"),
	clientToken: z.string().regex(CLIENT_TOKEN),
	origin: z.literal(QUARTERDECK_DESKTOP_ORIGIN),
});
const revocationSchema = z.strictObject({
	generation: z.string().uuid(),
	kind: z.literal("desktop"),
	clientToken: z.string().regex(CLIENT_TOKEN),
});

export interface RuntimeClientAccessOptions {
	generation: string;
	management: {
		getPublicDescriptor: () => PublicRuntimeOwnerDescriptor | null;
		verifyManagementToken: (token: string, generation: string) => boolean;
	};
}

function header(request: IncomingMessage, name: string): string | undefined {
	const value = request.headers[name];
	return typeof value === "string" ? value : undefined;
}

export function isLoopbackAddress(address: string | undefined): boolean {
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
		error: "Runtime client access is unavailable. Open Quarterdeck again from the desktop app.",
		code: "QUARTERDECK_CLIENT_ACCESS_REQUIRED",
	});
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

/** Per-generation desktop admission. Management and provider hooks retain separate credentials. */
export class RuntimeClientAccess {
	readonly generation: string;
	private readonly desktopClients = new Set<string>();
	private readonly sockets = new Map<Duplex, string>();
	private readonly desktopSocketRequests = new WeakSet<IncomingMessage>();
	private cleared = false;

	constructor(private readonly options: RuntimeClientAccessOptions) {
		this.generation = z.string().uuid().parse(options.generation);
	}

	registerDesktopClient(token: string): void {
		if (this.cleared || !CLIENT_TOKEN.test(token)) throw new Error("Invalid desktop client credential.");
		if (!this.desktopClients.has(token) && this.desktopClients.size >= MAX_CREDENTIALS) {
			throw new Error("Desktop client admission capacity reached.");
		}
		this.desktopClients.add(token);
	}

	revokeDesktopClient(token: string): void {
		const credential = this.findCredential(token);
		if (!credential) return;
		this.desktopClients.delete(credential);
		for (const [socket, admittedToken] of this.sockets) {
			if (admittedToken !== credential) continue;
			socket.destroy();
			this.sockets.delete(socket);
		}
	}

	clear(): void {
		this.cleared = true;
		this.desktopClients.clear();
		for (const socket of this.sockets.keys()) socket.destroy();
		this.sockets.clear();
	}

	async handleHttpRequest(
		request: IncomingMessage,
		response: ServerResponse,
		url: URL,
		openProject?: (projectPath: string) => Promise<RuntimeManagementProjectOpenResponse>,
	): Promise<boolean> {
		if (url.pathname.startsWith(MANAGEMENT_PREFIX))
			return await this.handleManagement(request, response, url, openProject);
		// Exact hook routes and command diagnostics perform their own scoped authentication.
		// A tRPC batch containing hooks plus another procedure must still require desktop admission.
		if (url.pathname === "/api/trpc/hooks.ingest" && request.method === "POST") return false;
		if (url.pathname === "/api/hooks/notify") return false;
		if (url.pathname.startsWith("/api/diagnostics/") && !RENDERER_DIAGNOSTIC_PATHS.has(url.pathname)) return false;
		return this.authorizeClient(request) ? false : rejectAccess(response);
	}

	handleSocketUpgrade(request: IncomingMessage, socket: Duplex, url: URL): boolean {
		const credential = this.authorizeClient(request);
		const presentationRequested =
			url.searchParams.has("notificationPresentation") || url.searchParams.has("notificationOnly");
		if (
			!SOCKET_PATHS.has(url.pathname) ||
			!credential ||
			(presentationRequested &&
				(header(request, "x-quarterdeck-runtime-generation") !== this.generation ||
					url.pathname !== "/api/runtime/ws" ||
					url.searchParams.getAll("notificationPresentation").length !== 1 ||
					url.searchParams.get("notificationPresentation") !== "desktop" ||
					url.searchParams.getAll("notificationOnly").length !== 1 ||
					url.searchParams.get("notificationOnly") !== "true"))
		) {
			socket.end("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\nCache-Control: no-store\r\n\r\n");
			return true;
		}
		this.desktopSocketRequests.add(request);
		this.sockets.set(socket, credential);
		socket.once("close", () => this.sockets.delete(socket));
		return false;
	}

	isDesktopSocketAdmitted(request: IncomingMessage): boolean {
		return this.desktopSocketRequests.has(request);
	}

	private isReady(): boolean {
		const descriptor = this.options.management.getPublicDescriptor();
		return !this.cleared && descriptor?.generation === this.generation && descriptor.status === "ready";
	}

	private findCredential(token: string | undefined): string | null {
		if (!token || !CLIENT_TOKEN.test(token)) return null;
		for (const expected of this.desktopClients) {
			if (matchesToken(token, expected)) return expected;
		}
		return null;
	}

	private authorizeClient(request: IncomingMessage): string | null {
		if (
			!this.isReady() ||
			(request.method !== "GET" && request.method !== "POST" && request.method !== "HEAD") ||
			header(request, "origin") !== QUARTERDECK_DESKTOP_ORIGIN ||
			header(request, "host") !== `127.0.0.1:${getQuarterdeckRuntimePort()}` ||
			!isLoopbackAddress(request.socket.remoteAddress)
		)
			return null;
		return this.findCredential(header(request, QUARTERDECK_DESKTOP_TOKEN_HEADER));
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
			!isLoopbackAddress(request.socket.remoteAddress) ||
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
				if (!descriptor.capabilities.desktopProxy || descriptor.capabilities.desktopBridgeVersion !== 1)
					return respond(response, 409, { error: "Runtime does not support desktop attachment." });
				this.registerDesktopClient(input.clientToken);
				return respond(response, 200, { generation: this.generation, enrolled: true });
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
