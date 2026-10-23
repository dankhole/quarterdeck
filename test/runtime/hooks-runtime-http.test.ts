import { createServer, type RequestListener, type Server } from "node:http";
import { createServer as createTcpServer, type Socket, type Server as TcpServer } from "node:net";

import { afterEach, describe, expect, it } from "vitest";

import { HOOK_RUNTIME_MAX_RESPONSE_BYTES, postHookRuntimeJson } from "../../src/hooks-runtime-http.js";

const servers: Array<Server | TcpServer> = [];
const sockets = new Set<Socket>();

async function listen(server: Server | TcpServer, host = "127.0.0.1"): Promise<string> {
	servers.push(server);
	server.on("connection", (socket: Socket) => {
		sockets.add(socket);
		socket.on("close", () => sockets.delete(socket));
	});
	await new Promise<void>((resolve, reject) => {
		server.once("error", reject);
		server.listen(0, host, () => {
			server.removeListener("error", reject);
			resolve();
		});
	});
	const address = server.address();
	if (!address || typeof address === "string") throw new Error("Expected a TCP port.");
	return `http://${host === "::1" ? "[::1]" : host}:${address.port}/api/trpc/hooks.ingest`;
}

async function httpServer(handler: RequestListener, host?: string): Promise<string> {
	return listen(createServer(handler), host);
}

async function rawResponse(response: string): Promise<string> {
	return listen(createTcpServer((socket) => socket.once("data", () => socket.end(response))));
}

afterEach(async () => {
	for (const socket of sockets) socket.destroy();
	for (const server of servers.splice(0)) {
		if (server.listening) await new Promise<void>((resolve) => server.close(() => resolve()));
	}
});

describe("hook runtime HTTP client", () => {
	it("sends UTF-8 JSON with exact Host/path/length and reads chunked UTF-8, interim responses and trailers", async () => {
		const body = JSON.stringify({ message: "héllo 🚢" });
		const received: Buffer[] = [];
		let host: string | undefined;
		let length: string | undefined;
		const reply = JSON.stringify({ result: { data: { ok: true, message: "é🚢" } } });
		const url = await httpServer((req, res) => {
			host = req.headers.host;
			length = req.headers["content-length"];
			expect(req.method).toBe("POST");
			expect(req.url).toBe("/api/trpc/hooks.ingest");
			expect(req.headers["content-type"]).toBe("application/json");
			req.on("data", (chunk: Buffer) => received.push(chunk));
			req.on("end", () => {
				res.writeProcessing();
				res.writeHead(200, { "content-type": "application/json", trailer: "x-hook-test" });
				const bytes = Buffer.from(reply);
				const split = bytes.indexOf(Buffer.from("🚢")) + 1;
				res.write(bytes.subarray(0, split));
				setImmediate(() => {
					res.addTrailers({ "x-hook-test": "complete" });
					res.end(bytes.subarray(split));
				});
			});
		});

		await expect(postHookRuntimeJson(url, body, new AbortController().signal)).resolves.toEqual({
			status: 200,
			body: reply,
		});
		expect(host).toBe(new URL(url).host);
		expect(length).toBe(String(Buffer.byteLength(body)));
		expect(Buffer.concat(received).toString("utf8")).toBe(body);
	});

	it("uses a bracketed IPv6 Host when IPv6 loopback is available", async ({ skip }) => {
		let host: string | undefined;
		let url: string;
		try {
			url = await httpServer((req, res) => {
				host = req.headers.host;
				res.end("ok");
			}, "::1");
		} catch (error) {
			if (
				error &&
				typeof error === "object" &&
				"code" in error &&
				["EADDRNOTAVAIL", "EAFNOSUPPORT", "ENETUNREACH"].includes(String(error.code))
			) {
				skip("IPv6 loopback unavailable");
				return;
			}
			throw error;
		}
		await expect(postHookRuntimeJson(url, "{}", new AbortController().signal)).resolves.toEqual({
			status: 200,
			body: "ok",
		});
		expect(host).toBe(new URL(url).host);
	});

	it("accepts a close-delimited HTTP body", async () => {
		const url = await rawResponse("HTTP/1.0 200 OK\r\n\r\ncomplete");
		await expect(postHookRuntimeJson(url, "{}", new AbortController().signal)).resolves.toEqual({
			status: 200,
			body: "complete",
		});
	});

	it.each(["headers", "body"])(
		"aborts while waiting for %s, preserving the reason and closing the actual socket",
		async (phase) => {
			let markReady!: () => void;
			let markClosed!: () => void;
			const ready = new Promise<void>((resolve) => {
				markReady = resolve;
			});
			const closed = new Promise<void>((resolve) => {
				markClosed = resolve;
			});
			const url = await httpServer((req, res) => {
				req.socket.once("close", markClosed);
				if (phase === "body") {
					res.writeHead(200, { "content-type": "application/json" });
					res.write('{"result":', markReady);
				} else markReady();
			});
			const controller = new AbortController();
			const reason = new Error(`cancel during ${phase}`);
			const rejection = expect(postHookRuntimeJson(url, "{}", controller.signal)).rejects.toBe(reason);
			await ready;
			// Give the emitted response headers/body a turn to reach the client.
			await new Promise<void>((resolve) => setImmediate(resolve));
			controller.abort(reason);
			await rejection;
			await closed;
		},
	);

	it("rejects an already-aborted signal without replacing its reason", async () => {
		const controller = new AbortController();
		const reason = { cancelled: true };
		controller.abort(reason);
		await expect(postHookRuntimeJson("http://127.0.0.1:1/", "{}", controller.signal)).rejects.toBe(reason);
	});

	it.each([
		["fixed-length", "HTTP/1.1 200 OK\r\nContent-Length: 100\r\n\r\npartial"],
		["chunked", "HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n7\r\npartial\r\n"],
	])("rejects a truncated %s response", async (_kind, response) => {
		const url = await rawResponse(response);
		await expect(postHookRuntimeJson(url, "{}", new AbortController().signal)).rejects.toThrow(/before completion/);
	});

	it.each([
		"HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\nnot-hex-private-body\r\n",
		"HTTP/1.1 200 OK\r\nContent-Length: 1\r\nContent-Length: 2\r\n\r\nxx",
	])("rejects malformed framing without exposing response bytes", async (response) => {
		const url = await rawResponse(response);
		await expect(postHookRuntimeJson(url, "{}", new AbortController().signal)).rejects.toThrow(
			"Hook ingest returned a malformed HTTP response.",
		);
	});

	it("rejects an unexpected protocol upgrade", async () => {
		const url = await rawResponse(
			"HTTP/1.1 101 Switching Protocols\r\nConnection: upgrade\r\nUpgrade: other\r\n\r\n",
		);
		await expect(postHookRuntimeJson(url, "{}", new AbortController().signal)).rejects.toThrow(
			/unexpected HTTP upgrade/,
		);
	});

	it("allows exactly 1 MiB but rejects a larger body", async () => {
		let bytes = HOOK_RUNTIME_MAX_RESPONSE_BYTES;
		const url = await httpServer((_req, res) => res.end(Buffer.alloc(bytes, "x")));
		const result = await postHookRuntimeJson(url, "{}", new AbortController().signal);
		expect(result.body.length).toBe(bytes);
		bytes += 1;
		await expect(postHookRuntimeJson(url, "{}", new AbortController().signal)).rejects.toThrow(/1 MiB limit/);
	});

	it("rejects connection refusal", async () => {
		const server = createServer();
		const url = await listen(server);
		await new Promise<void>((resolve) => server.close(() => resolve()));
		await expect(postHookRuntimeJson(url, "{}", new AbortController().signal)).rejects.toMatchObject({
			code: "ECONNREFUSED",
		});
	});

	it("rejects a connection reset before response headers", async () => {
		const url = await listen(createTcpServer((socket) => socket.once("data", () => socket.destroy())));
		await expect(postHookRuntimeJson(url, "{}", new AbortController().signal)).rejects.toMatchObject({
			code: "ECONNRESET",
		});
	});

	it("keeps a request open for an asynchronous server response", async () => {
		const url = await httpServer((req, res) => {
			req.resume();
			req.on("end", () => setTimeout(() => res.end("complete"), 50));
		});
		await expect(postHookRuntimeJson(url, "{}", new AbortController().signal)).resolves.toEqual({
			status: 200,
			body: "complete",
		});
	});
});
