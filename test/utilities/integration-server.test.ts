import * as childProcess from "node:child_process";
import { resolve } from "node:path";
import { PassThrough } from "node:stream";

import { afterEach, beforeEach, describe, expect, inject, it, vi } from "vitest";

import { terminateProcessTree } from "../../src/core/process-termination.js";
import { enrollDesktopClient, verifyRuntimeOwner } from "../../src/server/runtime-owner-client.js";
import { discoverRuntimeOwner } from "../../src/server/runtime-ownership.js";
import {
	resolveIntegrationEntrypoint,
	resolveTsxLoaderImportSpecifier,
	startQuarterdeckServer,
	waitForProcessStart,
} from "./integration-server";

vi.mock("node:child_process", async (importOriginal) => ({
	...(await importOriginal<typeof childProcess>()),
	spawn: vi.fn(),
}));
vi.mock("../../src/core/process-termination.js", () => ({ terminateProcessTree: vi.fn() }));
vi.mock("../../src/server/runtime-owner-client.js", () => ({
	verifyRuntimeOwner: vi.fn(async () => "http://127.0.0.1:1234"),
	enrollDesktopClient: vi.fn(async () => undefined),
}));
vi.mock("../../src/server/runtime-ownership.js", () => ({
	discoverRuntimeOwner: vi.fn(async () => ({ descriptor: { status: "ready", process: { pid: 12345 } } })),
}));

async function startFakeServer(sourceOnly = false) {
	const child = new childProcess.ChildProcess();
	Object.defineProperty(child, "pid", { value: 12345 });
	child.stdin = new PassThrough();
	const stdout = new PassThrough();
	child.stdout = stdout;
	child.stderr = new PassThrough();
	vi.mocked(childProcess.spawn).mockReturnValue(child);
	const starting = startQuarterdeckServer({
		cwd: process.cwd(),
		homeDir: process.cwd(),
		port: 1234,
		sourceOnly,
		extraEnv: { QUARTERDECK_AGENT_LAB: undefined },
	});
	stdout.write("Quarterdeck internal runtime running.\n");
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
			vi.fn(async () => Response.json({ result: { data: { currentProjectId: "test" } } })),
		);
	});
	afterEach(() => {
		vi.useRealTimers();
		vi.unstubAllGlobals();
		vi.restoreAllMocks();
	});

	it("authorizes the actual compiled process launch but does not opt a source launch into the lab", async () => {
		const { child, server } = await startFakeServer();
		const compiled = inject("compiledIntegrationEntrypoints")?.["src/cli.ts"];
		expect(childProcess.spawn).toHaveBeenCalledWith(
			process.execPath,
			compiled
				? [compiled, "--internal-runtime"]
				: ["--import", resolveTsxLoaderImportSpecifier(), resolve("src/cli.ts"), "--internal-runtime"],
			expect.objectContaining({ cwd: process.cwd(), stdio: ["pipe", "pipe", "pipe"] }),
		);
		expect(vi.mocked(childProcess.spawn).mock.calls[0]?.[2]?.env?.QUARTERDECK_AGENT_LAB).toBe(
			compiled ? "1" : undefined,
		);
		exitChild(child);
		child.emit("close", 0, null);
		await server.stop();
	});

	it("lets non-lab restart tests request the source CLI when a compiled entrypoint is available", async () => {
		const { child, server } = await startFakeServer(true);
		expect(childProcess.spawn).toHaveBeenCalledWith(
			process.execPath,
			["--import", resolveTsxLoaderImportSpecifier(), resolve("src/cli.ts"), "--internal-runtime"],
			expect.objectContaining({ env: expect.any(Object) }),
		);
		expect(vi.mocked(childProcess.spawn).mock.calls[0]?.[2]?.env?.QUARTERDECK_AGENT_LAB).toBeUndefined();
		exitChild(child);
		child.emit("close", 0, null);
		await server.stop();
	});

	it("uses management-issued desktop credentials without browser cookies or URL capabilities", async () => {
		const { child, server } = await startFakeServer();
		const descriptor = (await discoverRuntimeOwner("unused"))?.descriptor;
		expect(verifyRuntimeOwner).toHaveBeenCalledWith(descriptor, true);
		expect(enrollDesktopClient).toHaveBeenCalledWith(descriptor, expect.stringMatching(/^[A-Za-z0-9_-]{43}$/));
		expect(server.browserHeaders).toEqual({
			origin: "app://quarterdeck",
			"x-quarterdeck-desktop-token": vi.mocked(enrollDesktopClient).mock.calls[0]?.[1],
		});
		expect(server.browserHeaders).not.toHaveProperty("cookie");
		expect(server.runtimeUrl).toBe("http://127.0.0.1:1234/test");
		expect(fetch).toHaveBeenCalledWith(
			"http://127.0.0.1:1234/api/trpc/projects.list",
			expect.objectContaining({ headers: expect.any(Headers) }),
		);
		exitChild(child);
		child.emit("close", 0, null);
		await server.stop();
	});

	it("refuses to enroll clients into an owner other than the fixture child", async () => {
		const owner = await discoverRuntimeOwner("unused");
		if (!owner?.descriptor) throw new Error("Expected the synthetic owner fixture.");
		vi.mocked(discoverRuntimeOwner).mockResolvedValueOnce({
			...owner,
			descriptor: { ...owner.descriptor, process: { ...owner.descriptor.process, pid: 99999 } },
		});
		const child = new childProcess.ChildProcess();
		Object.defineProperty(child, "pid", { value: 12345 });
		child.stdin = new PassThrough();
		const stdout = new PassThrough();
		child.stdout = stdout;
		child.stderr = new PassThrough();
		vi.mocked(childProcess.spawn).mockReturnValue(child);
		const rejected = expect(
			startQuarterdeckServer({ cwd: process.cwd(), homeDir: process.cwd(), port: 1234 }),
		).rejects.toThrow("Isolated runtime is not owned by the fixture process.");
		stdout.write("Quarterdeck internal runtime running.\n");
		await vi.advanceTimersByTimeAsync(1);
		exitChild(child);
		child.emit("close", 0, null);
		await rejected;
		expect(verifyRuntimeOwner).not.toHaveBeenCalled();
		expect(enrollDesktopClient).not.toHaveBeenCalled();
	});

	it("resolves compiled entrypoints without a loader and retains deliberate source fixtures", () => {
		const compiled = resolve(".cache/synthetic-integration/cli.mjs");
		const compiledEntrypoints = { "src/cli.ts": compiled };
		expect(resolveIntegrationEntrypoint("src/cli.ts", compiledEntrypoints)).toEqual({ path: compiled, execArgv: [] });
		expect(resolveIntegrationEntrypoint("src/cli.ts", {})).toEqual({
			path: resolve("src/cli.ts"),
			execArgv: ["--import", resolveTsxLoaderImportSpecifier()],
		});
		// Deliberate source/import fixtures stay source even in a compiled run.
		expect(resolveIntegrationEntrypoint("src/core/graceful-shutdown.ts", compiledEntrypoints)).toEqual({
			path: resolve("src/core/graceful-shutdown.ts"),
			execArgv: ["--import", resolveTsxLoaderImportSpecifier()],
		});
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
