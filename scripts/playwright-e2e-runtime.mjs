#!/usr/bin/env node

import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const runtimePort = Number.parseInt(process.env.QUARTERDECK_E2E_RUNTIME_PORT ?? "3597", 10);
const tempRoot = mkdtempSync(join(tmpdir(), "quarterdeck-web-e2e-"));
const tempHome = join(tempRoot, "home");
const tempStateHome = join(tempRoot, "state");
const tempProject = join(tempRoot, "project");
let child = null;
let shuttingDown = false;

function fail(message) {
	console.error(`[e2e-runtime] ${message}`);
	process.exit(1);
}

function run(command, args, options = {}) {
	const result = spawnSync(command, args, {
		cwd: options.cwd ?? repoRoot,
		stdio: options.stdio ?? "pipe",
		encoding: "utf8",
		env: process.env,
	});
	if (result.status !== 0) {
		const output = [result.stdout, result.stderr].filter(Boolean).join("\n").trim();
		fail(`${command} ${args.join(" ")} failed${output ? `:\n${output}` : "."}`);
	}
}

async function assertPortAvailable(port) {
	await new Promise((resolvePort, rejectPort) => {
		const probe = createServer();
		probe.once("error", (error) => {
			rejectPort(error);
		});
		probe.listen(port, "127.0.0.1", () => {
			probe.close(resolvePort);
		});
	}).catch((error) => {
		const code = typeof error === "object" && error !== null && "code" in error ? String(error.code) : null;
		if (code === "EADDRINUSE") {
			fail(`Runtime port ${port} is already in use.`);
		}
		const message = error instanceof Error ? error.message : String(error);
		fail(`Could not probe runtime port ${port}${code ? ` (${code})` : ""}: ${message}`);
	});
}

async function prepareProject() {
	await mkdir(tempHome, { recursive: true });
	await mkdir(tempStateHome, { recursive: true });
	await mkdir(tempProject, { recursive: true });
	writeFileSync(join(tempProject, "README.md"), "# Quarterdeck e2e fixture\n", "utf8");
	run("git", ["init", "-b", "main"], { cwd: tempProject });
	run("git", ["config", "user.email", "e2e@example.invalid"], { cwd: tempProject });
	run("git", ["config", "user.name", "Quarterdeck E2E"], { cwd: tempProject });
	run("git", ["add", "README.md"], { cwd: tempProject });
	run("git", ["commit", "-m", "seed e2e fixture"], { cwd: tempProject });
}

function cleanupTempRoot() {
	rmSync(tempRoot, { recursive: true, force: true });
}

function stopChild(signal = "SIGTERM") {
	if (!child || child.exitCode !== null || shuttingDown) {
		return;
	}
	shuttingDown = true;
	child.kill(signal);
	setTimeout(() => {
		if (child && child.exitCode === null) {
			child.kill("SIGKILL");
		}
	}, 10_000).unref();
}

async function startRuntime() {
	const cliEntrypoint = join(repoRoot, "src/cli.ts");
	let tsxCliPath;
	try {
		tsxCliPath = fileURLToPath(import.meta.resolve("tsx/cli"));
	} catch {
		fail("Missing local tsx install. Run `npm install` first.");
	}

	child = spawn(
		process.execPath,
		[
			tsxCliPath,
			cliEntrypoint,
			"--no-open",
			"--skip-shutdown-cleanup",
			"--port",
			String(runtimePort),
		],
		{
			cwd: tempProject,
			env: {
				...process.env,
				HOME: tempHome,
				USERPROFILE: tempHome,
				QUARTERDECK_STATE_HOME: tempStateHome,
			},
			stdio: ["ignore", "inherit", "inherit"],
		},
	);

	child.on("error", (error) => {
		fail(`Runtime process failed to start: ${error.message}`);
	});
	child.on("exit", (code, signal) => {
		cleanupTempRoot();
		if (!shuttingDown && code !== 0) {
			fail(`Runtime process exited unexpectedly with ${signal ?? code}.`);
		}
		process.exit(code ?? 0);
	});
}

process.once("SIGINT", () => stopChild("SIGINT"));
process.once("SIGTERM", () => stopChild("SIGTERM"));
if (process.platform !== "win32") {
	process.once("SIGHUP", () => stopChild("SIGHUP"));
}
process.once("exit", cleanupTempRoot);

await assertPortAvailable(runtimePort);
await prepareProject();
await startRuntime();
