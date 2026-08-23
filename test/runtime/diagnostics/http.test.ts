import { mkdtemp, rm } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
	collectDiagnosticCapture,
	createRuntimeDiagnostics,
	handleDiagnosticsHttpRequest,
	probeRuntimeDiagnosticInstance,
	type RuntimeDiagnostics,
} from "../../../src/diagnostics";

describe("diagnostics HTTP authentication", () => {
	let directory: string;
	let diagnostics: RuntimeDiagnostics;
	let server: Server;
	let origin: string;

	beforeEach(async () => {
		directory = await mkdtemp(join(tmpdir(), "quarterdeck-diagnostics-http-"));
		diagnostics = await createRuntimeDiagnostics({
			stateHome: directory,
			host: "127.0.0.1",
			port: 42_424,
			quarterdeckVersion: "test",
		});
		server = createServer((request, response) => {
			const url = new URL(request.url ?? "/", "http://127.0.0.1");
			void handleDiagnosticsHttpRequest(request, response, url, diagnostics).then((handled) => {
				if (!handled) {
					response.writeHead(404);
					response.end();
				}
			});
		});
		await new Promise<void>((resolveListen) => server.listen(0, "127.0.0.1", resolveListen));
		const address = server.address();
		if (!address || typeof address === "string") throw new Error("Test server did not bind a TCP port.");
		origin = `http://127.0.0.1:${address.port}`;
	});

	afterEach(async () => {
		await new Promise<void>((resolveClose, rejectClose) => {
			server.close((error) => (error ? rejectClose(error) : resolveClose()));
		});
		await diagnostics.close();
		await rm(directory, { recursive: true, force: true });
	});

	it("rejects unauthenticated requests and never returns the private token", async () => {
		const rejected = await fetch(`${origin}/api/diagnostics/status`);
		expect(rejected.status).toBe(403);

		const token = diagnostics.instance.getDescriptor().diagnosticToken;
		const accepted = await fetch(`${origin}/api/diagnostics/status`, {
			headers: { "x-quarterdeck-diagnostic-token": token },
		});
		expect(accepted.status).toBe(200);
		const body = await accepted.text();
		expect(body).not.toContain(token);
		expect(JSON.parse(body)).toMatchObject({
			descriptor: { runtimeInstanceId: diagnostics.runtimeInstanceId },
			health: { runtimeInstanceId: diagnostics.runtimeInstanceId },
		});
	});

	it("authenticates the runtime instance identity instead of trusting PID liveness", async () => {
		const address = server.address();
		if (!address || typeof address === "string") throw new Error("Test server did not bind a TCP port.");
		const descriptor = { ...diagnostics.instance.getDescriptor(), port: address.port };
		const matching = await probeRuntimeDiagnosticInstance({
			descriptor,
			descriptorPath: diagnostics.instance.descriptorPath,
			pidAlive: true,
		});
		const mismatched = await probeRuntimeDiagnosticInstance({
			descriptor: { ...descriptor, runtimeInstanceId: "different-runtime" },
			descriptorPath: diagnostics.instance.descriptorPath,
			pidAlive: true,
		});

		expect(matching).toEqual({ reachable: true, instanceMatches: true });
		expect(mismatched).toEqual({ reachable: true, instanceMatches: false });
	});

	it("requires the browser capability and explicit opt-in for live diagnostics", async () => {
		const clientId = "browser-client";
		const capability = diagnostics.issueBrowserCapability(clientId);
		const headers = {
			"content-type": "application/json",
			"x-quarterdeck-client-id": clientId,
			"x-quarterdeck-diagnostic-capability": capability,
		};

		const rejected = await fetch(`${origin}/api/diagnostics/browser-subscription`, {
			method: "POST",
			body: JSON.stringify({ subscribed: true, revision: 1 }),
		});
		expect(rejected.status).toBe(403);

		const subscribed = await fetch(`${origin}/api/diagnostics/browser-subscription`, {
			method: "POST",
			headers,
			body: JSON.stringify({ subscribed: true, revision: 1 }),
		});
		expect(subscribed.status).toBe(200);
		expect(await subscribed.json()).toMatchObject({ subscribed: true, revision: 1, records: expect.any(Array) });
		expect(diagnostics.hasBrowserLiveSubscribers()).toBe(true);

		await fetch(`${origin}/api/diagnostics/browser-subscription`, {
			method: "POST",
			headers,
			body: JSON.stringify({ subscribed: false, revision: 2 }),
		});
		expect(diagnostics.hasBrowserLiveSubscribers()).toBe(false);
	});

	it("falls back to the crash-surviving journal when live authentication fails", async () => {
		diagnostics.recordEvent("runtime.test_evidence", {}, {}, { essential: true });
		await diagnostics.recorder.flush();
		const instance = {
			descriptor: { ...diagnostics.instance.getDescriptor(), diagnosticToken: "x".repeat(43) },
			descriptorPath: diagnostics.instance.descriptorPath,
			pidAlive: true,
		};

		const capture = await collectDiagnosticCapture(instance, { fallbackToJournal: true });
		expect(capture.records.some((record) => record.name === "runtime.test_evidence")).toBe(true);
		expect(capture.warnings[0]).toContain("journal fallback used");
	});
});
