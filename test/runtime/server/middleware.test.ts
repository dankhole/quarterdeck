import type { IncomingMessage, ServerResponse } from "node:http";
import { PassThrough } from "node:stream";

import { afterEach, describe, expect, it, vi } from "vitest";
import {
	getQuarterdeckRuntimeHost,
	getQuarterdeckRuntimePort,
	setQuarterdeckRuntimeHost,
	setQuarterdeckRuntimePort,
} from "../../../src/core";
import {
	evaluateCors,
	evaluateHost,
	getAllowedHostHeaders,
	getAllowedRuntimeOrigins,
	handleHttpRequest,
	handleSocketUpgrade,
} from "../../../src/server/middleware";

const originalRuntimeHost = getQuarterdeckRuntimeHost();
const originalRuntimePort = getQuarterdeckRuntimePort();

function makeFakeRequest(headers: Partial<IncomingMessage["headers"]>, method = "GET"): IncomingMessage {
	return { method, headers } as IncomingMessage;
}

afterEach(() => {
	setQuarterdeckRuntimeHost(originalRuntimeHost);
	setQuarterdeckRuntimePort(originalRuntimePort);
	vi.unstubAllEnvs();
});

describe("evaluateCors", () => {
	const allowedOrigins = new Set(["http://127.0.0.1:3500"]);

	it("allows requests with no Origin header", () => {
		expect(
			evaluateCors({
				method: "GET",
				originHeader: undefined,
				allowedOrigins,
			}),
		).toEqual({ kind: "allow", origin: null });
	});

	it("allows requests whose Origin is known", () => {
		expect(
			evaluateCors({
				method: "POST",
				originHeader: "http://127.0.0.1:3500",
				allowedOrigins,
			}),
		).toEqual({ kind: "allow", origin: "http://127.0.0.1:3500" });
	});

	it("returns a preflight decision for OPTIONS from a known Origin", () => {
		expect(
			evaluateCors({
				method: "OPTIONS",
				originHeader: "http://127.0.0.1:3500",
				allowedOrigins,
			}),
		).toEqual({ kind: "preflight", origin: "http://127.0.0.1:3500" });
	});

	it("rejects requests from unknown origins", () => {
		expect(
			evaluateCors({
				method: "GET",
				originHeader: "http://attacker.example.com",
				allowedOrigins,
			}),
		).toEqual({ kind: "reject", origin: "http://attacker.example.com" });
	});
});

describe("evaluateHost", () => {
	const allowedHosts = new Set(["127.0.0.1:3500", "localhost:3500"]);

	it("allows known Host headers case-insensitively", () => {
		expect(evaluateHost({ hostHeader: "LocalHost:3500", allowedHosts })).toEqual({ kind: "allow" });
	});

	it("rejects missing or unknown Host headers", () => {
		expect(evaluateHost({ hostHeader: undefined, allowedHosts })).toEqual({ kind: "reject", host: null });
		expect(evaluateHost({ hostHeader: "attacker.example.com:3500", allowedHosts })).toEqual({
			kind: "reject",
			host: "attacker.example.com:3500",
		});
	});
});

describe("runtime allowlists", () => {
	it("allows runtime host plus loopback aliases on the runtime port", () => {
		setQuarterdeckRuntimeHost("100.64.0.1");
		setQuarterdeckRuntimePort(4567);

		expect(getAllowedHostHeaders()).toEqual(
			new Set(["100.64.0.1:4567", "127.0.0.1:4567", "localhost:4567", "[::1]:4567"]),
		);
		expect(getAllowedRuntimeOrigins()).toContain("http://100.64.0.1:4567");
		expect(getAllowedRuntimeOrigins()).toContain("http://127.0.0.1:4567");
		expect(getAllowedRuntimeOrigins()).toContain("http://localhost:4567");
	});

	it.each(["development", "production", "test"])(
		"ignores retired web-port settings and Vite defaults in %s",
		(nodeEnv) => {
			setQuarterdeckRuntimeHost("127.0.0.1");
			setQuarterdeckRuntimePort(4567);
			vi.stubEnv("NODE_ENV", nodeEnv);
			vi.stubEnv("QUARTERDECK_E2E_WEB_PORT", "4174");
			vi.stubEnv("QUARTERDECK_WEB_UI_PORT", "4175");
			expect(getAllowedRuntimeOrigins()).toEqual(
				new Set(["http://127.0.0.1:4567", "http://localhost:4567", "http://[::1]:4567"]),
			);
		},
	);
});

describe("handleHttpRequest", () => {
	function makeFakeResponse() {
		return { setHeader: vi.fn(), writeHead: vi.fn(), end: vi.fn() };
	}

	it("retains opt-in desktop-origin preflight headers", () => {
		setQuarterdeckRuntimePort(3500);
		const response = makeFakeResponse();
		const request = makeFakeRequest({ host: "127.0.0.1:3500", origin: "app://quarterdeck" }, "OPTIONS");
		expect(handleHttpRequest(request, response as unknown as ServerResponse, true)).toEqual({ end: true });
		expect(response.writeHead).toHaveBeenCalledWith(204);
		expect(response.setHeader).toHaveBeenCalledWith("Access-Control-Allow-Origin", "app://quarterdeck");
		expect(response.setHeader).toHaveBeenCalledWith(
			"Access-Control-Allow-Headers",
			expect.stringContaining("X-Quarterdeck-Desktop-Token"),
		);
	});

	it("does not admit the desktop origin when its caller has not opted in", () => {
		setQuarterdeckRuntimePort(3500);
		const response = makeFakeResponse();
		const request = makeFakeRequest({ host: "127.0.0.1:3500", origin: "app://quarterdeck" });
		expect(handleHttpRequest(request, response as unknown as ServerResponse)).toEqual({ end: true });
		expect(response.writeHead).toHaveBeenCalledWith(403, expect.anything());
	});

	it.each([4173, 4174, 4175])("rejects retired browser development origin on port %s", (port) => {
		setQuarterdeckRuntimePort(3500);
		vi.stubEnv("NODE_ENV", "development");
		vi.stubEnv("QUARTERDECK_E2E_WEB_PORT", "4174");
		vi.stubEnv("QUARTERDECK_WEB_UI_PORT", "4175");
		const response = makeFakeResponse();
		const request = makeFakeRequest({ host: "127.0.0.1:3500", origin: `http://127.0.0.1:${port}` });
		expect(handleHttpRequest(request, response as unknown as ServerResponse, true)).toEqual({ end: true });
		expect(response.writeHead).toHaveBeenCalledWith(403, expect.anything());
		expect(response.setHeader).not.toHaveBeenCalled();
	});

	it("keeps no-Origin internal requests subject to the Host gate", () => {
		setQuarterdeckRuntimePort(3500);
		const response = makeFakeResponse();
		expect(
			handleHttpRequest(makeFakeRequest({ host: "127.0.0.1:3500" }), response as unknown as ServerResponse),
		).toEqual({ end: false });
		expect(
			handleHttpRequest(
				makeFakeRequest({ host: "attacker.example.com:3500" }),
				response as unknown as ServerResponse,
			),
		).toEqual({ end: true });
		expect(response.writeHead).toHaveBeenCalledWith(403, expect.anything());
	});
});

describe("handleSocketUpgrade", () => {
	it("retains explicitly enabled desktop upgrades", () => {
		setQuarterdeckRuntimePort(3500);
		const socket = new PassThrough();
		const request = makeFakeRequest({ host: "127.0.0.1:3500", origin: "app://quarterdeck" });
		expect(handleSocketUpgrade(request, socket, true)).toEqual({ end: false });
		expect(socket.destroyed).toBe(false);
	});

	it.each([4173, 4174, 4175])("rejects a retired browser development upgrade on port %s", (port) => {
		setQuarterdeckRuntimePort(3500);
		vi.stubEnv("NODE_ENV", "development");
		vi.stubEnv("QUARTERDECK_E2E_WEB_PORT", "4174");
		vi.stubEnv("QUARTERDECK_WEB_UI_PORT", "4175");
		const socket = new PassThrough();
		const request = makeFakeRequest({ host: "127.0.0.1:3500", origin: `http://127.0.0.1:${port}` });
		expect(handleSocketUpgrade(request, socket, true)).toEqual({ end: true });
		expect(socket.destroyed).toBe(true);
	});

	it("passes through upgrades whose Host and Origin are allowed", () => {
		setQuarterdeckRuntimePort(3500);
		const socket = new PassThrough();
		const request = makeFakeRequest({ host: "127.0.0.1:3500", origin: "http://127.0.0.1:3500" });

		expect(handleSocketUpgrade(request, socket)).toEqual({ end: false });
		expect(socket.destroyed).toBe(false);
	});

	it("rejects upgrades from an unknown origin", () => {
		setQuarterdeckRuntimePort(3500);
		const socket = new PassThrough();
		const written: Buffer[] = [];
		socket.on("data", (chunk) => {
			written.push(chunk as Buffer);
		});
		const request = makeFakeRequest({ host: "127.0.0.1:3500", origin: "http://attacker.example.com" });

		expect(handleSocketUpgrade(request, socket)).toEqual({ end: true });
		expect(socket.destroyed).toBe(true);
		expect(Buffer.concat(written).toString("utf8")).toContain("HTTP/1.1 403 Forbidden");
	});

	it("rejects upgrades with an unknown Host header", () => {
		setQuarterdeckRuntimePort(3500);
		const socket = new PassThrough();
		const request = makeFakeRequest({ host: "attacker.example.com:3500", origin: "http://127.0.0.1:3500" });

		expect(handleSocketUpgrade(request, socket)).toEqual({ end: true });
		expect(socket.destroyed).toBe(true);
	});
});
