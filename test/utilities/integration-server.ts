import { type ChildProcess, spawn } from "node:child_process";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { inject } from "vitest";

import { sanitizeRuntimeLogOutput } from "../../scripts/agent-lab/runtime-log-sanitizer.js";
import { terminateProcessTree } from "../../src/core/process-termination.js";
import { createOwnerBrowserBootstrap, verifyRuntimeOwner } from "../../src/server/runtime-owner-client.js";
import { discoverRuntimeOwner } from "../../src/server/runtime-ownership.js";
import { createGitTestEnv } from "./git-env";

const requireFromHere = createRequire(import.meta.url);

export async function getAvailablePort(): Promise<number> {
	const server = createServer();
	await new Promise<void>((resolveListen, rejectListen) => {
		server.once("error", rejectListen);
		server.listen(0, "127.0.0.1", () => resolveListen());
	});
	const address = server.address();
	const port = typeof address === "object" && address ? address.port : null;
	await new Promise<void>((resolveClose, rejectClose) => {
		server.close((error) => {
			if (error) {
				rejectClose(error);
				return;
			}
			resolveClose();
		});
	});
	if (!port) {
		throw new Error("Could not allocate a test port.");
	}
	return port;
}

export function resolveTsxLoaderImportSpecifier(): string {
	return pathToFileURL(requireFromHere.resolve("tsx")).href;
}

export function resolveTsxCliPath(): string {
	return requireFromHere.resolve("tsx/cli");
}

/** Source by default; the integration lane may provide a fresh disposable build. */
export function resolveIntegrationEntrypoint(
	source = "src/cli.ts",
	compiledEntrypoints = inject("compiledIntegrationEntrypoints"),
): { path: string; execArgv: string[] } {
	const compiled = compiledEntrypoints?.[source];
	return compiled
		? { path: compiled, execArgv: [] }
		: { path: resolve(process.cwd(), source), execArgv: ["--import", resolveTsxLoaderImportSpecifier()] };
}

export function resolveIntegrationNodeArgs(source = "src/cli.ts"): string[] {
	const entrypoint = resolveIntegrationEntrypoint(source);
	return [...entrypoint.execArgv, entrypoint.path];
}

export async function waitForProcessStart(
	childProcess: ChildProcess,
	timeoutMs = 10_000,
): Promise<{ runtimeUrl: string }> {
	return await new Promise((resolveStart, rejectStart) => {
		if (!childProcess.stdout || !childProcess.stderr) {
			rejectStart(new Error("Expected child process stdout/stderr pipes to be available."));
			return;
		}
		let settled = false;
		let stdout = "";
		let stderr = "";
		const timeoutId = setTimeout(() => {
			if (settled) {
				return;
			}
			settled = true;
			rejectStart(
				new Error(
					`Timed out waiting for server start.\nstdout:\n${sanitizeRuntimeLogOutput(stdout)}\nstderr:\n${sanitizeRuntimeLogOutput(stderr)}`,
				),
			);
		}, timeoutMs);
		const handleOutput = (chunk: Buffer, source: "stdout" | "stderr") => {
			const text = chunk.toString();
			if (source === "stdout") {
				stdout += text;
			} else {
				stderr += text;
			}
			const match = stdout.match(/Quarterdeck running at (http:\/\/127\.0\.0\.1:\d+(?:\/[^\s]*)?)/);
			if (!match || settled) {
				return;
			}
			const runtimeUrl = match[1];
			if (!runtimeUrl) {
				return;
			}
			settled = true;
			clearTimeout(timeoutId);
			resolveStart({ runtimeUrl });
		};
		childProcess.stdout.on("data", (chunk: Buffer) => {
			handleOutput(chunk, "stdout");
		});
		childProcess.stderr.on("data", (chunk: Buffer) => {
			handleOutput(chunk, "stderr");
		});
		childProcess.once("exit", (code, signal) => {
			if (settled) {
				return;
			}
			settled = true;
			clearTimeout(timeoutId);
			rejectStart(
				new Error(
					`Server process exited before startup (code=${String(code)} signal=${String(signal)}).\nstdout:\n${sanitizeRuntimeLogOutput(stdout)}\nstderr:\n${sanitizeRuntimeLogOutput(stderr)}`,
				),
			);
		});
	});
}

export async function waitForExit(childProcess: ChildProcess, timeoutMs: number): Promise<boolean> {
	if (childProcess.exitCode !== null || childProcess.signalCode !== null) {
		return true;
	}

	return await new Promise<boolean>((resolveExit) => {
		const handleExit = () => {
			clearTimeout(timeoutId);
			resolveExit(true);
		};
		const timeoutId = setTimeout(() => {
			childProcess.removeListener("exit", handleExit);
			resolveExit(false);
		}, timeoutMs);
		childProcess.once("exit", handleExit);
	});
}

function getShutdownSignal(): NodeJS.Signals {
	return process.platform === "win32" ? "SIGTERM" : "SIGINT";
}

export async function requestGracefulShutdown(childProcess: ChildProcess): Promise<void> {
	if (childProcess.stdin && !childProcess.stdin.destroyed && !childProcess.stdin.writableEnded) {
		childProcess.stdin.end();
		return;
	}
	childProcess.kill(getShutdownSignal());
}

/** Enroll a browser against this disposable fixture, without exposing management credentials to clients. */
export async function createFixtureBrowserHeaders(
	runtimeUrl: string,
	stateHome: string,
): Promise<Readonly<Record<string, string>>> {
	const owner = await discoverRuntimeOwner(stateHome);
	const descriptor = owner?.descriptor;
	if (descriptor?.status !== "ready") throw new Error("Isolated runtime owner is not ready.");
	const origin = await verifyRuntimeOwner(descriptor, false);
	if (origin !== new URL(runtimeUrl).origin) throw new Error("Isolated runtime endpoint changed during admission.");
	const bootstrapUrl = await createOwnerBrowserBootstrap(descriptor);
	const exchange = await fetch(bootstrapUrl, { redirect: "manual", signal: AbortSignal.timeout(3_000) });
	const cookie = exchange.headers.get("set-cookie")?.split(";")[0];
	if (exchange.status !== 303 || !cookie) throw new Error("Isolated browser admission failed.");
	return Object.freeze({ cookie, origin });
}

export async function startQuarterdeckServer(input: {
	cwd: string;
	homeDir: string;
	port: number;
	extraArgs?: string[];
	extraEnv?: NodeJS.ProcessEnv;
}): Promise<{
	runtimeUrl: string;
	browserHeaders: Readonly<Record<string, string>>;
	crash: () => Promise<void>;
	stop: () => Promise<void>;
}> {
	const stateHome = resolve(input.extraEnv?.QUARTERDECK_STATE_HOME ?? join(input.homeDir, ".quarterdeck"));
	const child = spawn(process.execPath, [...resolveIntegrationNodeArgs(), "--no-open", ...(input.extraArgs ?? [])], {
		cwd: input.cwd,
		env: createGitTestEnv({
			...input.extraEnv,
			HOME: input.homeDir,
			USERPROFILE: input.homeDir,
			QUARTERDECK_STATE_HOME: stateHome,
			QUARTERDECK_RUNTIME_PORT: String(input.port),
		}),
		stdio: ["pipe", "pipe", "pipe"],
		windowsHide: true,
	});
	// Observe close from launch: exit alone can precede stdio/descendant cleanup,
	// and the process may already have closed by the time teardown starts.
	const closed = new Promise<void>((resolveClose) => child.once("close", () => resolveClose()));
	const waitForClose = async (timeoutMs: number): Promise<boolean> =>
		await new Promise<boolean>((resolveClose) => {
			const timeoutId = setTimeout(() => resolveClose(false), timeoutMs);
			void closed.then(() => {
				clearTimeout(timeoutId);
				resolveClose(true);
			});
		});
	const stop = async () => {
		if (child.exitCode === null && child.signalCode === null) {
			await requestGracefulShutdown(child);
		}
		// Exceed the CLI's 8s Windows / 10s POSIX shutdown deadlines.
		if (await waitForClose(12_000)) {
			return;
		}

		if (child.exitCode !== null || child.signalCode !== null) {
			throw new Error("Quarterdeck test server exited but its stdio did not close.");
		}
		const pid = child.pid;
		if (pid === undefined) {
			throw new Error("Cannot stop quarterdeck test server without a process PID.");
		}
		await new Promise<void>((resolveTermination, rejectTermination) => {
			terminateProcessTree(pid, "SIGKILL", (error) => {
				if (error) {
					rejectTermination(
						new Error("Failed to terminate quarterdeck test server process tree.", { cause: error }),
					);
					return;
				}
				resolveTermination();
			});
		});
		if (!(await waitForClose(5_000))) {
			throw new Error("Timed out waiting for quarterdeck test server process to close.");
		}
	};
	try {
		const { runtimeUrl } = await waitForProcessStart(child);
		const browserHeaders = await createFixtureBrowserHeaders(runtimeUrl, stateHome);
		return {
			runtimeUrl,
			browserHeaders,
			stop,
			crash: async () => {
				if (child.exitCode !== null) {
					return;
				}
				child.kill("SIGKILL");
				if (!(await waitForExit(child, 5_000))) {
					throw new Error("Timed out crashing quarterdeck test server process.");
				}
			},
		};
	} catch (error) {
		try {
			await stop();
		} catch (cleanupError) {
			throw new AggregateError([error, cleanupError], "Isolated runtime startup and cleanup failed.");
		}
		throw error;
	}
}
