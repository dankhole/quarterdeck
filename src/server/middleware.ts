import type { IncomingMessage, ServerResponse } from "node:http";
import type { Duplex } from "node:stream";

import { getQuarterdeckRuntimeHost, getQuarterdeckRuntimeOrigin, getQuarterdeckRuntimePort } from "../core";

const VITE_DEV_PORT = 4173;
const PREFLIGHT_MAX_AGE_SECONDS = "600";
const ALLOWED_METHODS = ["GET", "POST", "OPTIONS"].join(", ");
const ALLOWED_HEADERS = ["Authorization", "Content-Type", "X-Quarterdeck-Client-Id", "X-Quarterdeck-Project-Id"].join(
	", ",
);

export type CorsDecision =
	| { kind: "allow"; origin: string | null }
	| { kind: "preflight"; origin: string }
	| { kind: "reject"; origin: string };

export interface CorsGateInput {
	method: string | undefined;
	originHeader: string | undefined;
	allowedOrigins: ReadonlySet<string>;
}

export type HostDecision = { kind: "allow" } | { kind: "reject"; host: string | null };

export interface HostGateInput {
	hostHeader: string | undefined;
	allowedHosts: ReadonlySet<string>;
}

function isDevelopmentMode(): boolean {
	return process.env.NODE_ENV === "development";
}

function normalizeHeaderValue(value: string | undefined): string | null {
	const trimmed = value?.trim();
	return trimmed ? trimmed : null;
}

function addHttpOrigin(origins: Set<string>, host: string, port: number): void {
	origins.add(`http://${host}:${port}`);
}

function addHostHeader(hosts: Set<string>, host: string, port: number): void {
	hosts.add(`${host}:${port}`.toLowerCase());
}

function readOptionalPort(value: string | undefined): number | null {
	const normalized = value?.trim();
	if (!normalized || !/^\d+$/.test(normalized)) {
		return null;
	}
	const parsed = Number.parseInt(normalized, 10);
	return Number.isFinite(parsed) && parsed > 0 && parsed <= 65535 ? parsed : null;
}

function getDevelopmentWebUiPorts(): number[] {
	const ports = new Set<number>([VITE_DEV_PORT]);
	for (const rawPort of [process.env.QUARTERDECK_WEB_UI_PORT, process.env.QUARTERDECK_E2E_WEB_PORT]) {
		const parsed = readOptionalPort(rawPort);
		if (parsed !== null) {
			ports.add(parsed);
		}
	}
	return [...ports];
}

export function getAllowedRuntimeOrigins(): ReadonlySet<string> {
	const port = getQuarterdeckRuntimePort();
	const runtimeHost = getQuarterdeckRuntimeHost().toLowerCase();
	const allowed = new Set<string>([getQuarterdeckRuntimeOrigin()]);

	addHttpOrigin(allowed, runtimeHost, port);
	addHttpOrigin(allowed, "127.0.0.1", port);
	addHttpOrigin(allowed, "localhost", port);
	addHttpOrigin(allowed, "[::1]", port);

	if (isDevelopmentMode()) {
		for (const webUiPort of getDevelopmentWebUiPorts()) {
			addHttpOrigin(allowed, "127.0.0.1", webUiPort);
			addHttpOrigin(allowed, "localhost", webUiPort);
			addHttpOrigin(allowed, "[::1]", webUiPort);
		}
	}

	return allowed;
}

export function getAllowedHostHeaders(): ReadonlySet<string> {
	const port = getQuarterdeckRuntimePort();
	const runtimeHost = getQuarterdeckRuntimeHost().toLowerCase();
	const allowed = new Set<string>();

	addHostHeader(allowed, runtimeHost, port);
	addHostHeader(allowed, "127.0.0.1", port);
	addHostHeader(allowed, "localhost", port);
	addHostHeader(allowed, "[::1]", port);

	return allowed;
}

export function evaluateCors(input: CorsGateInput): CorsDecision {
	const origin = normalizeHeaderValue(input.originHeader);
	if (origin === null) {
		return { kind: "allow", origin: null };
	}

	if (!input.allowedOrigins.has(origin)) {
		return { kind: "reject", origin };
	}

	if (input.method === "OPTIONS") {
		return { kind: "preflight", origin };
	}

	return { kind: "allow", origin };
}

export function evaluateHost(input: HostGateInput): HostDecision {
	const host = normalizeHeaderValue(input.hostHeader);
	if (host === null) {
		return { kind: "reject", host: null };
	}

	if (!input.allowedHosts.has(host.toLowerCase())) {
		return { kind: "reject", host };
	}

	return { kind: "allow" };
}

function applyAllowedOriginHeaders(res: ServerResponse, origin: string): void {
	res.setHeader("Access-Control-Allow-Origin", origin);
	res.setHeader("Access-Control-Allow-Credentials", "true");
	res.setHeader("Vary", "Origin");
}

function rejectHttpRequest(res: ServerResponse, message: string): { end: true } {
	res.writeHead(403, {
		"Cache-Control": "no-store",
		"Content-Type": "application/json; charset=utf-8",
	});
	res.end(JSON.stringify({ error: message }));
	return { end: true };
}

function rejectSocketUpgrade(socket: Duplex): { end: true } {
	socket.write("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n");
	socket.destroy();
	return { end: true };
}

export function handleHttpRequest(req: IncomingMessage, res: ServerResponse): { end: boolean } {
	const hostDecision = evaluateHost({
		hostHeader: req.headers.host,
		allowedHosts: getAllowedHostHeaders(),
	});
	if (hostDecision.kind === "reject") {
		return rejectHttpRequest(res, "Host not allowed.");
	}

	const corsDecision = evaluateCors({
		method: req.method,
		originHeader: req.headers.origin,
		allowedOrigins: getAllowedRuntimeOrigins(),
	});
	switch (corsDecision.kind) {
		case "allow": {
			if (corsDecision.origin !== null) {
				applyAllowedOriginHeaders(res, corsDecision.origin);
			}
			return { end: false };
		}
		case "preflight": {
			applyAllowedOriginHeaders(res, corsDecision.origin);
			res.setHeader("Access-Control-Allow-Methods", ALLOWED_METHODS);
			res.setHeader("Access-Control-Allow-Headers", ALLOWED_HEADERS);
			res.setHeader("Access-Control-Max-Age", PREFLIGHT_MAX_AGE_SECONDS);
			res.writeHead(204);
			res.end();
			return { end: true };
		}
		case "reject": {
			return rejectHttpRequest(res, "Origin not allowed.");
		}
	}
}

export function handleSocketUpgrade(request: IncomingMessage, socket: Duplex): { end: boolean } {
	const hostDecision = evaluateHost({
		hostHeader: request.headers.host,
		allowedHosts: getAllowedHostHeaders(),
	});
	if (hostDecision.kind === "reject") {
		return rejectSocketUpgrade(socket);
	}

	const corsDecision = evaluateCors({
		method: request.method,
		originHeader: request.headers.origin,
		allowedOrigins: getAllowedRuntimeOrigins(),
	});
	if (corsDecision.kind === "reject") {
		return rejectSocketUpgrade(socket);
	}

	return { end: false };
}
