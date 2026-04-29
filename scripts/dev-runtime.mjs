#!/usr/bin/env node

import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
	installForwardedShutdownHandlers,
	launchManagedProcess,
	resolveExitCode,
} from "./dev-process.mjs";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

let tsxCliPath;
try {
	tsxCliPath = fileURLToPath(import.meta.resolve("tsx/cli"));
} catch {
	console.error("[dev-runtime] Missing local tsx install. Run `npm install` first.");
	process.exit(1);
}

const runtime = launchManagedProcess(process.execPath, [tsxCliPath, "watch", "src/cli.ts", ...process.argv.slice(2)], {
	cwd: repoRoot,
	env: {
		...process.env,
		NODE_ENV: process.env.NODE_ENV ?? "development",
	},
	onForceKill: () => {
		console.error("[dev-runtime] Runtime did not exit before timeout. Force killing...");
	},
});

const uninstallSignalHandlers = installForwardedShutdownHandlers((signal) => {
	runtime.requestShutdown(signal);
});

runtime.exitPromise
	.then((exitInfo) => {
		uninstallSignalHandlers();
		if (exitInfo.error) {
			console.error(`[dev-runtime] Failed to launch runtime: ${exitInfo.error.message}`);
		}
		process.exit(resolveExitCode(exitInfo, runtime.shutdownSignal));
	})
	.catch((error) => {
		uninstallSignalHandlers();
		const message = error instanceof Error ? error.message : String(error);
		console.error(`[dev-runtime] ${message}`);
		process.exit(1);
	});
