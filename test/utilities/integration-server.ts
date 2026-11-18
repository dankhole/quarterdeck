import { type ChildProcess, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { inject } from "vitest";

import { sanitizeRuntimeLogOutput } from "../../scripts/agent-lab/runtime-log-sanitizer.js";
import {
	QUARTERDECK_DESKTOP_ORIGIN,
	QUARTERDECK_DESKTOP_TOKEN_HEADER,
} from "../../src/core/api/desktop-runtime-protocol.js";
import { runtimeProjectsResponseSchema } from "../../src/core/api/project-state.js";
import { terminateProcessTree } from "../../src/core/process-termination.js";
import { enrollDesktopClient, verifyRuntimeOwner } from "../../src/server/runtime-owner-client.js";
import { discoverRuntimeOwner } from "../../src/server/runtime-ownership.js";
import { createGitTestEnv } from "./git-env";
import { requestJson } from "./trpc-request";

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
	// Heavy machine load can slow process spawn/startup well past the fast-lane
	// default; keep this consistent with the ~60s budget used by process-heavy
	// fixtures (see test/utilities/process-test-budget.ts) rather than the
	// previous 10s, which raced real load even for a correctly starting server.
	timeoutMs = 30_000,
): Promise<void> {
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
			if (!/Quarterdeck internal runtime (?:already )?running\./.test(stdout) || settled) return;
			settled = true;
			clearTimeout(timeoutId);
			resolveStart();
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

/** Use production desktop enrollment for synthetic clients; never create a browser authentication bypass. */
async function createFixtureDesktopAccess(stateHome: string, expectedPid: number | undefined) {
	const owner = await discoverRuntimeOwner(stateHome);
	const descriptor = owner?.descriptor;
	if (descriptor?.status !== "ready") throw new Error("Isolated runtime owner is not ready.");
	if (expectedPid === undefined || descriptor.process.pid !== expectedPid)
		throw new Error("Isolated runtime is not owned by the fixture process.");
	const runtimeOrigin = await verifyRuntimeOwner(descriptor, true);
	const token = randomBytes(32).toString("base64url");
	await enrollDesktopClient(descriptor, token);
	const headers = Object.freeze({ [QUARTERDECK_DESKTOP_TOKEN_HEADER]: token, origin: QUARTERDECK_DESKTOP_ORIGIN });
	const projects = await requestJson<unknown>({
		baseUrl: runtimeOrigin,
		procedure: "projects.list",
		type: "query",
		headers,
	});
	if (projects.status !== 200) throw new Error("Isolated runtime project discovery failed.");
	const { currentProjectId } = runtimeProjectsResponseSchema.pick({ currentProjectId: true }).parse(projects.payload);
	return { runtimeUrl: `${runtimeOrigin}/${currentProjectId ? encodeURIComponent(currentProjectId) : ""}`, headers };
}

export async function startQuarterdeckServer(input: {
	cwd: string;
	homeDir: string;
	port: number;
	extraArgs?: string[];
	extraEnv?: NodeJS.ProcessEnv;
	startupTimeoutMs?: number;
}): Promise<{
	runtimeUrl: string;
	/** Renderer clients use management-enrolled desktop headers, despite this retained fixture property name. */
	browserHeaders: Readonly<Record<string, string>>;
	crash: () => Promise<void>;
	stop: () => Promise<void>;
}> {
	const stateHome = resolve(input.extraEnv?.QUARTERDECK_STATE_HOME ?? join(input.homeDir, ".quarterdeck"));
	const child = spawn(
		process.execPath,
		[...resolveIntegrationNodeArgs(), "--internal-runtime", ...(input.extraArgs ?? [])],
		{
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
		},
	);
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
		await waitForProcessStart(child, input.startupTimeoutMs);
		const { runtimeUrl, headers: browserHeaders } = await createFixtureDesktopAccess(stateHome, child.pid);
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
