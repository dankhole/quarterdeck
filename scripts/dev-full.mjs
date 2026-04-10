#!/usr/bin/env node

/**
 * Starts both the runtime dev server and the web UI dev server in a single process.
 * Forwards stdout/stderr from both, prefixed with [runtime] and [web-ui].
 * Kills both when either exits or when this process receives SIGINT/SIGTERM.
 */

import { spawn } from "node:child_process";

const children = [];

function prefix(label, stream, dest) {
	stream.on("data", (chunk) => {
		for (const line of chunk.toString().split("\n")) {
			if (line) dest.write(`[${label}] ${line}\n`);
		}
	});
}

function launch(label, command, args) {
	const child = spawn(command, args, {
		stdio: ["ignore", "pipe", "pipe"],
		cwd: process.cwd(),
	});
	prefix(label, child.stdout, process.stdout);
	prefix(label, child.stderr, process.stderr);
	child.on("exit", (code) => {
		console.log(`[${label}] exited with code ${code}`);
		cleanup();
	});
	children.push(child);
}

function cleanup() {
	for (const child of children) {
		if (!child.killed) child.kill("SIGTERM");
	}
	process.exit(0);
}

process.on("SIGINT", cleanup);
process.on("SIGTERM", cleanup);

launch("runtime", "npx", ["tsx", "watch", "src/cli.ts"]);
launch("web-ui", "npm", ["--prefix", "web-ui", "run", "dev"]);

console.log("[dev-full] Starting runtime + web-ui dev servers...");
