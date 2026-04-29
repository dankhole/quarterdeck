#!/usr/bin/env node

/**
 * Starts both the runtime dev server and the web UI dev server in a single process.
 * Forwards stdout/stderr from both, prefixed with [runtime] and [web-ui].
 * Shuts both down when either exits or when this process receives SIGINT/SIGTERM.
 */

import {
	getExitCodeForSignal,
	installForwardedShutdownHandlers,
	launchManagedProcess,
	resolveExitCode,
} from "./dev-process.mjs";

const children = [];
const npmCommand = process.platform === "win32" ? "npm.cmd" : "npm";
let isShuttingDown = false;
let shutdownExitCode = 0;
let shutdownPromise = null;

function prefix(label, stream, dest) {
	let buffered = "";
	stream.on("data", (chunk) => {
		buffered += chunk.toString();
		const lines = buffered.split("\n");
		buffered = lines.pop() ?? "";
		for (const line of lines) {
			if (line) dest.write(`[${label}] ${line}\n`);
		}
	});
	stream.on("end", () => {
		if (buffered) {
			dest.write(`[${label}] ${buffered}\n`);
			buffered = "";
		}
	});
}

function launch(label, command, args) {
	const managed = launchManagedProcess(command, args, {
		stdio: ["ignore", "pipe", "pipe"],
		cwd: process.cwd(),
		onForceKill: () => {
			console.error(`[${label}] did not exit before timeout. Force killing...`);
		},
	});
	prefix(label, managed.child.stdout, process.stdout);
	prefix(label, managed.child.stderr, process.stderr);
	children.push({ label, managed });
	managed.exitPromise.then((exitInfo) => {
		const exitCode = resolveExitCode(exitInfo, managed.shutdownSignal);
		console.log(`[${label}] exited with code ${exitCode}`);
		if (!isShuttingDown) {
			void requestShutdown("SIGTERM", exitCode);
		}
	});
}

function requestShutdown(signal, exitCode = getExitCodeForSignal(signal)) {
	if (isShuttingDown) {
		return shutdownPromise;
	}
	isShuttingDown = true;
	shutdownExitCode = exitCode;
	for (const { managed } of children) {
		managed.requestShutdown(signal);
	}
	shutdownPromise = Promise.all(children.map(({ managed }) => managed.exitPromise)).then(() => {
		uninstallSignalHandlers();
		process.exit(shutdownExitCode);
	});
	return shutdownPromise;
}

const uninstallSignalHandlers = installForwardedShutdownHandlers((signal) => {
	void requestShutdown(signal);
});

launch("runtime", process.execPath, ["scripts/dev-runtime.mjs", ...process.argv.slice(2)]);
launch("web-ui", npmCommand, ["--prefix", "web-ui", "run", "dev"]);

console.log("[dev-full] Starting runtime + web-ui dev servers...");
