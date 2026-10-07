import { IncomingMessage } from "node:http";
import type { Socket } from "node:net";
import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";
import { isTrustedDevNavigation } from "../../../web-ui/dev-runtime-admission";

function navigation(): IncomingMessage {
	const stream = new PassThrough();
	Object.defineProperty(stream, "remoteAddress", { value: "127.0.0.1", writable: true });
	const request = new IncomingMessage(stream as unknown as Socket);
	request.method = "GET";
	request.url = "/project";
	request.headers = { host: "127.0.0.1:5000", accept: "text/html", "sec-fetch-site": "none" };
	return request;
}

describe("trusted development browser admission boundary", () => {
	it("admits only a local HTML navigation for the exact development origin", () => {
		const request = navigation();
		expect(isTrustedDevNavigation(request, "http://127.0.0.1:5000")).toBe(true);
		request.headers.origin = "http://127.0.0.1:5000";
		request.headers["sec-fetch-site"] = "same-origin";
		expect(isTrustedDevNavigation(request, "http://127.0.0.1:5000")).toBe(true);
		for (const origin of ["https://evil.example", "http://127.0.0.1:5001", "null"]) {
			request.headers.origin = origin;
			expect(isTrustedDevNavigation(request, "http://127.0.0.1:5000")).toBe(false);
		}
	});
	it("rejects cross-site, API, remote, and nonnavigation requests", () => {
		for (const mutate of [
			(request: IncomingMessage) => {
				request.headers["sec-fetch-site"] = "cross-site";
			},
			(request: IncomingMessage) => {
				request.headers["sec-fetch-site"] = "same-site";
			},
			(request: IncomingMessage) => {
				request.headers.host = "127.0.0.1:5001";
			},
			(request: IncomingMessage) => {
				request.method = "POST";
			},
			(request: IncomingMessage) => {
				request.headers.accept = "application/json";
			},
			(request: IncomingMessage) => {
				request.url = "/api/trpc/runtime.getConfig";
			},
			(request: IncomingMessage) => {
				Object.defineProperty(request.socket, "remoteAddress", { value: "10.0.0.1" });
			},
		]) {
			const request = navigation();
			mutate(request);
			expect(isTrustedDevNavigation(request, "http://127.0.0.1:5000")).toBe(false);
		}
	});
});
