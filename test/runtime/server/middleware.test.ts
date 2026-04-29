import type { IncomingMessage } from "node:http";
import { PassThrough } from "node:stream";

import { afterEach, describe, expect, it } from "vitest";
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
	handleSocketUpgrade,
} from "../../../src/server/middleware";

const originalRuntimeHost = getQuarterdeckRuntimeHost();
const originalRuntimePort = getQuarterdeckRuntimePort();
const originalNodeEnv = process.env.NODE_ENV;
const originalE2eWebPort = process.env.QUARTERDECK_E2E_WEB_PORT;

function makeFakeRequest(headers: Partial<IncomingMessage["headers"]>, method = "GET"): IncomingMessage {
	return { method, headers } as IncomingMessage;
}

afterEach(() => {
	setQuarterdeckRuntimeHost(originalRuntimeHost);
	setQuarterdeckRuntimePort(originalRuntimePort);
	if (originalNodeEnv === undefined) {
		delete process.env.NODE_ENV;
	} else {
		process.env.NODE_ENV = originalNodeEnv;
	}
	if (originalE2eWebPort === undefined) {
		delete process.env.QUARTERDECK_E2E_WEB_PORT;
	} else {
		process.env.QUARTERDECK_E2E_WEB_PORT = originalE2eWebPort;
	}
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

	it("allows Vite dev origins only in development", () => {
		setQuarterdeckRuntimePort(4567);
		process.env.NODE_ENV = "test";
		expect(getAllowedRuntimeOrigins()).not.toContain("http://127.0.0.1:4173");

		process.env.NODE_ENV = "development";
		expect(getAllowedRuntimeOrigins()).toContain("http://127.0.0.1:4173");
		expect(getAllowedRuntimeOrigins()).toContain("http://localhost:4173");

		process.env.QUARTERDECK_E2E_WEB_PORT = "4174";
		expect(getAllowedRuntimeOrigins()).toContain("http://127.0.0.1:4174");
	});
});

describe("handleSocketUpgrade", () => {
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
