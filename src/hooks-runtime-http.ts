import { type IncomingMessage, request } from "node:http";

export const HOOK_RUNTIME_MAX_RESPONSE_BYTES = 1024 * 1024;

interface HookRuntimeHttpResponse {
	status: number;
	body: string;
}

/** One bounded HTTP POST; Node owns framing, and abort owns the entire response lifetime. */
export function postHookRuntimeJson(url: string, body: string, signal: AbortSignal): Promise<HookRuntimeHttpResponse> {
	if (signal.aborted) return Promise.reject(signal.reason);
	return new Promise((resolve, reject) => {
		let settled = false;
		let response: IncomingMessage | undefined;
		const req = request(url, {
			method: "POST",
			agent: false,
			headers: {
				"content-type": "application/json",
				"content-length": Buffer.byteLength(body),
			},
		});
		const cleanup = () => {
			signal.removeEventListener("abort", onAbort);
			req.destroy();
			response?.destroy();
		};
		const fail = (error: unknown) => {
			if (settled) return;
			settled = true;
			cleanup();
			reject(error);
		};
		const onAbort = () => fail(signal.reason);
		req.on("error", (error: Error) => {
			// Parser diagnostics must not expose untrusted response bytes.
			fail(
				"code" in error && typeof error.code === "string" && error.code.startsWith("HPE_")
					? new Error("Hook ingest returned a malformed HTTP response.")
					: error,
			);
		});
		req.on("close", () => {
			if (!response) fail(new Error("Hook ingest connection closed before a response."));
		});
		req.on("upgrade", (_res, socket) => {
			socket.destroy();
			fail(new Error("Hook ingest returned an unexpected HTTP upgrade."));
		});
		req.on("response", (res) => {
			response = res;
			if (settled) {
				res.destroy();
				return;
			}
			const chunks: Buffer[] = [];
			let bytes = 0;
			res.on("data", (chunk: Buffer) => {
				bytes += chunk.length;
				if (bytes > HOOK_RUNTIME_MAX_RESPONSE_BYTES) {
					fail(new Error("Hook ingest response exceeded the 1 MiB limit."));
					return;
				}
				chunks.push(chunk);
			});
			res.on("error", () => fail(new Error("Hook ingest response terminated before completion.")));
			res.on("close", () => {
				if (!settled) fail(new Error("Hook ingest response terminated before completion."));
			});
			res.on("end", () => {
				if (settled) return;
				if (!res.complete) {
					fail(new Error("Hook ingest response terminated before completion."));
					return;
				}
				settled = true;
				cleanup();
				resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks, bytes).toString("utf8") });
			});
		});
		signal.addEventListener("abort", onAbort, { once: true });
		if (signal.aborted) onAbort();
		else req.end(body);
	});
}
