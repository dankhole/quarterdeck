import type { IncomingMessage } from "node:http";
import { getRuntimeHomePath } from "../src/core/runtime-state-home";
import { createOwnerBrowserBootstrap, verifyRuntimeOwner } from "../src/server/runtime-owner-client";
import { discoverRuntimeOwner } from "../src/server/runtime-ownership";
import type { Plugin } from "vite";

function isLoopback(address: string | undefined): boolean {
	return address === "127.0.0.1" || address === "::1" || address === "::ffff:127.0.0.1";
}

export function isTrustedDevNavigation(request: IncomingMessage, devOrigin: string): boolean {
	const origin = new URL(devOrigin);
	const requestedOrigin = request.headers.origin;
	const fetchSite = request.headers["sec-fetch-site"];
	return (
		request.method === "GET" &&
		isLoopback(request.socket.remoteAddress) &&
		request.headers.host === origin.host &&
		(requestedOrigin === undefined || requestedOrigin === origin.origin) &&
		(fetchSite === undefined || fetchSite === "none" || fetchSite === "same-origin") &&
		typeof request.headers.accept === "string" &&
		request.headers.accept.includes("text/html") &&
		!new URL(request.url ?? "/", devOrigin).pathname.startsWith("/api/")
	);
}

/** Private Node-only dev admission. Production assets never include this plugin. */
export function runtimeDevAdmissionPlugin(runtimeOrigin: string): Plugin {
	return {
		name: "quarterdeck-development-client-admission",
		apply: "serve",
		configureServer(server) {
			server.middlewares.use((request, response, next) => {
				const address = server.httpServer?.address();
				if (!address || typeof address === "string") return next();
				const host = request.headers.host;
				if (host !== `127.0.0.1:${address.port}` && host !== `localhost:${address.port}` && host !== `[::1]:${address.port}`)
					return next();
				const devOrigin = `http://${host}`;
				if (!isTrustedDevNavigation(request, devOrigin)) return next();
				void (async () => {
					const owner = await discoverRuntimeOwner(getRuntimeHomePath());
					if (!owner?.descriptor || owner.released || owner.descriptor.status !== "ready") return;
					if ((await verifyRuntimeOwner(owner.descriptor, false)) !== runtimeOrigin) return;
					const admitted = await fetch(`${runtimeOrigin}/api/trpc/runtime.getConfig`, {
						headers: { ...(request.headers.cookie ? { cookie: request.headers.cookie } : {}) },
						redirect: "error",
						signal: AbortSignal.timeout(2_000),
					});
					await admitted.body?.cancel();
					if (admitted.status !== 401) return;
					const bootstrap = await createOwnerBrowserBootstrap(owner.descriptor);
					const exchanged = await fetch(bootstrap, { redirect: "manual", signal: AbortSignal.timeout(2_000) });
					await exchanged.body?.cancel();
					const cookies = exchanged.headers.getSetCookie();
					if (exchanged.status === 303 && cookies.length > 0 && !response.headersSent) {
						response.setHeader("Set-Cookie", cookies);
						response.setHeader("Cache-Control", "no-store");
					}
				})().catch(() => {
					// Let the normal connection UI report startup/offline/auth-required status.
				}).finally(() => next());
			});
		},
	};
}
