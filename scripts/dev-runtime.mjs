#!/usr/bin/env node

import { watch } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
	installForwardedShutdownHandlers,
	launchManagedProcess,
	resolveExitCode,
} from "./dev-process.mjs";
import { getProcessEnvironmentValue, mergeProcessEnvironment } from "./process-environment.mjs";

const SOURCE_RESTART_DEBOUNCE_MS = 100;
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const sourceRoot = resolve(repoRoot, "src");

let tsxLoaderImportSpecifier;
try {
	tsxLoaderImportSpecifier = import.meta.resolve("tsx");
} catch {
	console.error("[dev-runtime] Missing local tsx install. Run `npm install` first.");
	process.exit(1);
}

let runtime = null;
let restartTimer = null;
let restartPromise = null;
let restartRequested = false;
let stopping = false;
let exited = false;
let watcherClosed = false;
const expectedExits = new WeakSet();
let uninstallSignalHandlers = () => {};

const sourceWatcher = watch(sourceRoot, { recursive: true }, (_eventType, fileName) => {
	if (stopping) {
		return;
	}
	if (restartTimer !== null) {
		clearTimeout(restartTimer);
	}
	restartTimer = setTimeout(() => {
		restartTimer = null;
		const changedPath = fileName ? ` after ${String(fileName)} changed` : "";
		console.log(`[dev-runtime] Restarting runtime${changedPath}...`);
		void requestRestart();
	}, SOURCE_RESTART_DEBOUNCE_MS);
});

function closeWatcher() {
	if (watcherClosed) {
		return;
	}
	watcherClosed = true;
	if (restartTimer !== null) {
		clearTimeout(restartTimer);
		restartTimer = null;
	}
	sourceWatcher.close();
}

function exitWrapper(exitCode) {
	if (exited) {
		return;
	}
	exited = true;
	closeWatcher();
	uninstallSignalHandlers();
	process.exit(exitCode);
}

function launchRuntime() {
	const managed = launchManagedProcess(
		process.execPath,
		["--import", tsxLoaderImportSpecifier, "src/cli.ts", ...process.argv.slice(2)],
		{
			cwd: repoRoot,
			env: mergeProcessEnvironment(process.env, {
				NODE_ENV: getProcessEnvironmentValue(process.env, "NODE_ENV") ?? "development",
			}),
			gracefulShutdownViaStdin: true,
			onForceKill: () => {
				console.error("[dev-runtime] Runtime did not exit before timeout. Force killing...");
			},
		},
	);
	managed.exitPromise
		.then((exitInfo) => {
			if (expectedExits.has(managed) || stopping || managed !== runtime) {
				return;
			}
			exitWrapper(resolveExitCode(exitInfo, managed.shutdownSignal));
		})
		.catch((error) => {
			if (expectedExits.has(managed) || stopping || managed !== runtime) {
				return;
			}
			const message = error instanceof Error ? error.message : String(error);
			console.error(`[dev-runtime] ${message}`);
			exitWrapper(1);
		});
	return managed;
}

async function stopRuntime(managed, signal) {
	if (managed.exitInfo !== null) {
		return managed.exitInfo;
	}
	expectedExits.add(managed);
	managed.requestShutdown(signal);
	return await managed.exitPromise;
}

async function requestRestart() {
	if (stopping) {
		return;
	}
	restartRequested = true;
	if (restartPromise !== null) {
		return await restartPromise;
	}

	restartPromise = (async () => {
		while (restartRequested && !stopping) {
			restartRequested = false;
			await stopRuntime(runtime, "SIGTERM");
			if (!stopping) {
				runtime = launchRuntime();
			}
		}
	})();
	try {
		await restartPromise;
	} finally {
		restartPromise = null;
	}
}

async function requestShutdown(signal) {
	if (stopping) {
		return;
	}
	stopping = true;
	closeWatcher();
	try {
		if (restartPromise !== null) {
			await restartPromise;
		}
		const exitInfo = await stopRuntime(runtime, signal);
		exitWrapper(resolveExitCode(exitInfo, runtime.shutdownSignal ?? signal));
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		console.error(`[dev-runtime] ${message}`);
		exitWrapper(1);
	}
}

sourceWatcher.on("error", (error) => {
	console.error(`[dev-runtime] Source watcher failed: ${error.message}`);
	void requestShutdown("SIGTERM");
});

runtime = launchRuntime();
uninstallSignalHandlers = installForwardedShutdownHandlers((signal) => {
	void requestShutdown(signal);
});
