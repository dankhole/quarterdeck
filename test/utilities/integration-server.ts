import { type ChildProcess, spawn } from "node:child_process";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

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

export function resolveShutdownIpcHookPath(): string {
	return resolve(process.cwd(), "test/integration/shutdown-ipc-hook.cjs");
}

export function resolveTsxLoaderImportSpecifier(): string {
	return pathToFileURL(requireFromHere.resolve("tsx")).href;
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
			rejectStart(new Error(`Timed out waiting for server start.\nstdout:\n${stdout}\nstderr:\n${stderr}`));
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
					`Server process exited before startup (code=${String(code)} signal=${String(signal)}).\nstdout:\n${stdout}\nstderr:\n${stderr}`,
				),
			);
		});
	});
}

export async function waitForExit(childProcess: ChildProcess, timeoutMs: number): Promise<boolean> {
	if (childProcess.exitCode !== null) {
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
	if (typeof childProcess.send !== "function" || !childProcess.connected) {
		childProcess.kill(getShutdownSignal());
		return;
	}

	await new Promise<void>((resolveSend) => {
		childProcess.send({ type: "quarterdeck.shutdown" }, (error) => {
			if (error) {
				childProcess.kill(getShutdownSignal());
			}
			resolveSend();
		});
	});
}

export async function startQuarterdeckServer(input: {
	cwd: string;
	homeDir: string;
	port: number;
	extraArgs?: string[];
}): Promise<{
	runtimeUrl: string;
	stop: () => Promise<void>;
}> {
	const cliEntrypoint = resolve(process.cwd(), "src/cli.ts");
	const shutdownIpcHookPath = resolveShutdownIpcHookPath();
	const tsxLoaderImportSpecifier = resolveTsxLoaderImportSpecifier();
	const child = spawn(
		process.execPath,
		[
			"--require",
			shutdownIpcHookPath,
			"--import",
			tsxLoaderImportSpecifier,
			cliEntrypoint,
			"--no-open",
			...(input.extraArgs ?? []),
		],
		{
			cwd: input.cwd,
			env: createGitTestEnv({
				HOME: input.homeDir,
				USERPROFILE: input.homeDir,
				QUARTERDECK_RUNTIME_PORT: String(input.port),
			}),
			stdio: ["ignore", "pipe", "pipe", "ipc"],
		},
	);
	const { runtimeUrl } = await waitForProcessStart(child);
	return {
		runtimeUrl,
		stop: async () => {
			if (child.exitCode !== null) {
				return;
			}
			await requestGracefulShutdown(child);
			const didExitGracefully = await waitForExit(child, 5_000);
			if (didExitGracefully) {
				return;
			}

			child.kill("SIGKILL");
			const didExitAfterForce = await waitForExit(child, 5_000);
			if (!didExitAfterForce) {
				throw new Error("Timed out stopping quarterdeck test server process.");
			}
		},
	};
}
