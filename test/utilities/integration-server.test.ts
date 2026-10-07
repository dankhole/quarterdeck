import * as childProcess from "node:child_process";
import { PassThrough } from "node:stream";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { terminateProcessTree } from "../../src/core/process-termination.js";
import { startQuarterdeckServer, waitForProcessStart } from "./integration-server";

vi.mock("node:child_process", async (importOriginal) => ({
	...(await importOriginal<typeof childProcess>()),
	spawn: vi.fn(),
}));
vi.mock("../../src/core/process-termination.js", () => ({ terminateProcessTree: vi.fn() }));
vi.mock("../../src/server/runtime-owner-client.js", () => ({
	verifyRuntimeOwner: vi.fn(async () => "http://127.0.0.1:1234"),
	createOwnerBrowserBootstrap: vi.fn(
		async () => "http://127.0.0.1:1234/api/runtime/client-bootstrap?capability=synthetic",
	),
}));
vi.mock("../../src/server/runtime-ownership.js", () => ({
	discoverRuntimeOwner: vi.fn(async () => ({ descriptor: { status: "ready" } })),
}));

async function startFakeServer() {
	const child = new childProcess.ChildProcess();
	Object.defineProperty(child, "pid", { value: 12345 });
	child.stdin = new PassThrough();
	const stdout = new PassThrough();
	child.stdout = stdout;
	child.stderr = new PassThrough();
	vi.mocked(childProcess.spawn).mockReturnValue(child);
	const starting = startQuarterdeckServer({ cwd: process.cwd(), homeDir: process.cwd(), port: 1234 });
	stdout.write("Quarterdeck running at http://127.0.0.1:1234/test\n");
	return { child, server: await starting };
}

function exitChild(child: childProcess.ChildProcess): void {
	Object.defineProperty(child, "exitCode", { value: 0 });
	child.emit("exit", 0, null);
}

function finishTreeTermination(error?: Error): void {
	const callback = vi.mocked(terminateProcessTree).mock.calls[0]?.[2];
	expect(callback).toBeTypeOf("function");
	callback?.(error);
}

describe("integration server teardown", () => {
	beforeEach(() => {
		vi.useFakeTimers();
		vi.clearAllMocks();
		vi.stubGlobal(
			"fetch",
			vi.fn(
				async () =>
					new Response(null, {
						status: 303,
						headers: { "set-cookie": "qd-synthetic=synthetic; HttpOnly; Path=/" },
					}),
			),
		);
	});
	afterEach(() => {
		vi.useRealTimers();
		vi.unstubAllGlobals();
	});

	it("allows the runtime's full shutdown deadline before forcing termination", async () => {
		const { child, server } = await startFakeServer();
		const stopping = server.stop();
		expect(child.stdin?.writableEnded).toBe(true);
		await vi.advanceTimersByTimeAsync(10_500);
		expect(terminateProcessTree).not.toHaveBeenCalled();
		exitChild(child);
		child.emit("close", 0, null);
		await stopping;
		expect(vi.getTimerCount()).toBe(0);
	});

	it("waits for stdio close after the parent exits", async () => {
		const { child, server } = await startFakeServer();
		exitChild(child);
		const stopped = vi.fn();
		const stopping = server.stop().then(stopped);
		await vi.advanceTimersByTimeAsync(1);
		expect(stopped).not.toHaveBeenCalled();
		child.emit("close", 0, null);
		await stopping;
		expect(terminateProcessTree).not.toHaveBeenCalled();
	});

	it("recognizes close that occurred before stop was requested", async () => {
		const { child, server } = await startFakeServer();
		Object.defineProperty(child, "signalCode", { value: "SIGKILL" });
		child.emit("exit", null, "SIGKILL");
		child.emit("close", null, "SIGKILL");
		await server.stop();
		expect(child.stdin?.writableEnded).toBe(false);
		expect(terminateProcessTree).not.toHaveBeenCalled();
		expect(vi.getTimerCount()).toBe(0);
	});

	it("awaits tree termination even when the parent closes first", async () => {
		const { child, server } = await startFakeServer();
		const stopped = vi.fn();
		const stopping = server.stop().then(stopped);
		await vi.advanceTimersByTimeAsync(12_000);
		expect(terminateProcessTree).toHaveBeenCalledWith(child.pid, "SIGKILL", expect.any(Function));
		exitChild(child);
		child.emit("close", 0, null);
		await vi.advanceTimersByTimeAsync(1);
		expect(stopped).not.toHaveBeenCalled();
		finishTreeTermination();
		await stopping;
	});

	it("awaits parent close after tree termination completes", async () => {
		const { child, server } = await startFakeServer();
		const stopped = vi.fn();
		const stopping = server.stop().then(stopped);
		await vi.advanceTimersByTimeAsync(12_000);
		finishTreeTermination();
		exitChild(child);
		await vi.advanceTimersByTimeAsync(1);
		expect(stopped).not.toHaveBeenCalled();
		child.emit("close", 0, null);
		await stopping;
	});

	it("surfaces tree termination errors even after parent close", async () => {
		const { child, server } = await startFakeServer();
		const failure = new Error("taskkill failed");
		const rejected = expect(server.stop()).rejects.toMatchObject({
			message: "Failed to terminate quarterdeck test server process tree.",
			cause: failure,
		});
		await vi.advanceTimersByTimeAsync(12_000);
		exitChild(child);
		child.emit("close", 0, null);
		finishTreeTermination(failure);
		await rejected;
	});

	it("fails when the terminated process never closes", async () => {
		const { server } = await startFakeServer();
		const rejected = expect(server.stop()).rejects.toThrow(
			"Timed out waiting for quarterdeck test server process to close.",
		);
		await vi.advanceTimersByTimeAsync(12_000);
		finishTreeTermination();
		await vi.advanceTimersByTimeAsync(5_000);
		await rejected;
	});

	it("does not target an exited PID when stdio stays open", async () => {
		const { child, server } = await startFakeServer();
		exitChild(child);
		const rejected = expect(server.stop()).rejects.toThrow(
			"Quarterdeck test server exited but its stdio did not close.",
		);
		await vi.advanceTimersByTimeAsync(12_000);
		await rejected;
		expect(terminateProcessTree).not.toHaveBeenCalled();
	});

	it("redacts browser capabilities from failed readiness output on both pipes", async () => {
		const child = new childProcess.ChildProcess();
		const stdout = new PassThrough();
		const stderr = new PassThrough();
		child.stdout = stdout;
		child.stderr = stderr;
		const starting = waitForProcessStart(child);
		stdout.write("Browser URL: http://127.0.0.1:1234/api/runtime/client-bootstrap?capability=stdout-secret\n");
		stderr.write("Failed /api/runtime/client-bootstrap?capability=stderr-secret\n");
		child.emit("exit", 1, null);
		const failure = await starting.catch((error: unknown) => error);
		expect(failure).toBeInstanceOf(Error);
		expect((failure as Error).message).toContain("[private browser bootstrap]");
		expect((failure as Error).message).not.toContain("stdout-secret");
		expect((failure as Error).message).not.toContain("stderr-secret");
	});
});
