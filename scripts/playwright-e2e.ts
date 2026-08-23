#!/usr/bin/env node

import { spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { resolveLoopbackPort } from "./agent-lab/loopback-port";

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const webUiRoot = join(repoRoot, "web-ui");
const playwrightCli = join(webUiRoot, "node_modules", "@playwright", "test", "cli.js");

function optionalPort(value: string | undefined, name: string): number | null {
	if (value === undefined || value.trim() === "") return null;
	const port = Number.parseInt(value, 10);
	if (!Number.isInteger(port) || port < 1 || port > 65_535) throw new Error(`Invalid ${name}: ${value}`);
	return port;
}

const requestedRuntimePort = optionalPort(process.env.QUARTERDECK_E2E_RUNTIME_PORT, "Playwright runtime port");
const requestedWebPort = optionalPort(process.env.QUARTERDECK_E2E_WEB_PORT, "Playwright web UI port");
const runtimePort = await resolveLoopbackPort(requestedRuntimePort, "Playwright runtime");
let webPort = await resolveLoopbackPort(requestedWebPort, "Playwright web UI");
while (webPort === runtimePort) webPort = await resolveLoopbackPort(null, "Playwright web UI");

const child = spawn(process.execPath, [playwrightCli, "test", ...process.argv.slice(2)], {
	cwd: webUiRoot,
	env: {
		...process.env,
		QUARTERDECK_E2E_RUNTIME_PORT: String(runtimePort),
		QUARTERDECK_E2E_WEB_PORT: String(webPort),
	},
	stdio: "inherit",
});

const forwardedSignals = ["SIGINT", "SIGTERM"] as const;
const signalHandlers = forwardedSignals.map((signal) => {
	const handler = (): void => {
		child.kill(signal);
	};
	process.once(signal, handler);
	return { signal, handler };
});

const exitCode = await new Promise<number>((resolveExit, rejectExit) => {
	child.once("error", rejectExit);
	child.once("exit", (code, signal) => {
		if (signal) {
			process.stderr.write(`Playwright exited from ${signal}.\n`);
			resolveExit(1);
			return;
		}
		resolveExit(code ?? 1);
	});
}).finally(() => {
	for (const { signal, handler } of signalHandlers) process.removeListener(signal, handler);
});

process.exitCode = exitCode;
