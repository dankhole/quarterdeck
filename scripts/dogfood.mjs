#!/usr/bin/env node

import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { realpathSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { delimiter, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { resolveNpmCommand } from "./npm-command.mjs";
import { terminateProcessTree } from "./process-tree.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..");
const nodeBinary = process.execPath;

function printHelp() {
	console.log(
		"Usage: npm run dogfood -- [--project <path>] [--port <number|auto>] [--no-open] [--skip-build]",
	);
}

function parseArgs(argv) {
	let project = "";
	let port = "auto";
	let noOpen = false;
	let skipBuild = false;

	for (let index = 0; index < argv.length; index += 1) {
		const arg = argv[index];
		if (arg === "--help" || arg === "-h") {
			printHelp();
			process.exit(0);
		}
		if (arg === "--project" || arg === "-p") {
			const value = argv[index + 1];
			if (!value) {
				throw new Error("Missing value for --project.");
			}
			project = value;
			index += 1;
			continue;
		}
		if (arg.startsWith("--project=")) {
			project = arg.slice("--project=".length);
			continue;
		}
		if (arg === "--port") {
			const value = argv[index + 1];
			if (!value) {
				throw new Error("Missing value for --port.");
			}
			port = value;
			index += 1;
			continue;
		}
		if (arg.startsWith("--port=")) {
			port = arg.slice("--port=".length);
			continue;
		}
		if (arg === "--no-open") {
			noOpen = true;
			continue;
		}
		if (arg === "--skip-build") {
			skipBuild = true;
			continue;
		}
		throw new Error(`Unknown option: ${arg}`);
	}

	return {
		project: project.trim() ? resolve(project.trim()) : null,
		port: port.trim() || "auto",
		noOpen,
		skipBuild,
	};
}

function runCommand(command, args, spawnOptions = {}) {
	return new Promise((resolveExit, reject) => {
		const child = spawn(command, args, {
			stdio: "inherit",
			windowsHide: true,
			...spawnOptions,
		});

		child.on("error", (err) => {
			reject(err);
		});
		child.on("close", (code) => {
			resolveExit(typeof code === "number" ? code : 1);
		});
	});
}

function runRuntimeCommand(command, args, spawnOptions = {}) {
	return new Promise((resolveExit, reject) => {
		const child = spawn(command, args, {
			stdio: "inherit",
			detached: process.platform !== "win32",
			windowsHide: true,
			...spawnOptions,
		});

		// Dogfood used to rely on the shell/npm process group behavior, but under
		// `npm run dogfood` Ctrl+C could reach the runtime twice: once directly
		// from the terminal group and again through npm wrapper shutdown. That
		// second SIGINT was enough to make Quarterdeck force-exit before shutdown
		// cleanup finished, which left in_progress/review cards behind. Running
		// the runtime in its own process group and forwarding exactly one graceful
		// shutdown signal from this wrapper keeps shutdown deterministic while
		// still giving us a timed SIGKILL fallback if the child hangs.
		const sendSignalToChild = (signal) => {
			if (child.exitCode !== null || child.pid == null) {
				return;
			}
			if (process.platform !== "win32") {
				try {
					process.kill(-child.pid, signal);
					return;
				} catch (error) {
					if (error && typeof error === "object" && "code" in error && error.code === "ESRCH") {
						return;
					}
				}
			}
			child.kill(signal);
		};

		let shutdownStarted = false;
		let forceKillTimer = null;
		const requestShutdown = (signal) => {
			if (shutdownStarted) {
				return;
			}
			shutdownStarted = true;
			if (!child.stdin || child.stdin.destroyed || child.stdin.writableEnded) {
				sendSignalToChild(signal);
			} else {
				child.stdin.end();
			}
			forceKillTimer = setTimeout(() => {
				if (child.pid != null) {
					terminateProcessTree(child.pid, "SIGKILL", (error) => {
						if (error) sendSignalToChild("SIGKILL");
					});
				}
			// The child runtime uses an eight-second Windows cleanup budget. Give it
			// one second to finish its own timeout path before the wrapper kills the tree.
			}, process.platform === "win32" ? 9_000 : 11_000);
		};

		const onSigint = () => {
			requestShutdown("SIGINT");
		};
		const onSigterm = () => {
			requestShutdown("SIGTERM");
		};
		const onSighup = () => {
			requestShutdown("SIGTERM");
		};
		const onSigbreak = () => {
			requestShutdown("SIGTERM");
		};

		process.on("SIGINT", onSigint);
		process.on("SIGTERM", onSigterm);
		process.on("SIGHUP", onSighup);
		if (process.platform === "win32") process.on("SIGBREAK", onSigbreak);

		const cleanup = () => {
			if (forceKillTimer !== null) {
				clearTimeout(forceKillTimer);
				forceKillTimer = null;
			}
			process.off("SIGINT", onSigint);
			process.off("SIGTERM", onSigterm);
			process.off("SIGHUP", onSighup);
			if (process.platform === "win32") process.off("SIGBREAK", onSigbreak);
		};

		child.on("error", (err) => {
			cleanup();
			reject(err);
		});
		child.on("close", (code) => {
			cleanup();
			resolveExit(typeof code === "number" ? code : 1);
		});
	});
}

function stripNodeModulesBinFromPath(pathValue) {
	if (typeof pathValue !== "string" || pathValue.length === 0) {
		return pathValue;
	}
	// `npm run dogfood` prepends this repo's node_modules/.bin, which can shadow
	// globally installed agent CLIs (codex/claude/etc) that Quarterdeck should exercise.
	// This is mostly a dogfood/dev-launch issue; normal installed CLI usage does
	// not inject repo-local node_modules/.bin ahead of user PATH entries.
	return pathValue
		.split(delimiter)
		.filter((entry) => {
			const normalized = entry
				.trim()
				.replaceAll("\\", "/")
				.replace(/\/+$/u, "")
				.toLowerCase();
			return !normalized.endsWith("/node_modules/.bin");
		})
		.join(delimiter);
}

export function getDefaultDogfoodStateHome(checkoutRoot = repoRoot, userHome = homedir()) {
	const canonicalRoot = realpathSync(checkoutRoot);
	const identity = process.platform === "win32" ? canonicalRoot.toLowerCase() : canonicalRoot;
	const checkoutId = createHash("sha256").update(identity).digest("hex").slice(0, 24);
	return resolve(userHome, ".quarterdeck-dogfood", "checkouts", checkoutId);
}

export function buildDogfoodRuntimeEnv(baseEnv, checkoutRoot = repoRoot, userHome = homedir()) {
	const runtimeEnv = { ...baseEnv };
	let hasStateHome = false;
	for (const key of Object.keys(runtimeEnv)) {
		const normalizedKey = key.toUpperCase();
		if (normalizedKey === "PATH") {
			runtimeEnv[key] = stripNodeModulesBinFromPath(runtimeEnv[key]);
		}
		if (normalizedKey === "QUARTERDECK_STATE_HOME" && runtimeEnv[key]) {
			hasStateHome = true;
		}
	}
	// Isolate dogfood state from the user's real quarterdeck session so that
	// testing feature branches doesn't clobber in-flight board state.
	// Spreading `process.env` creates an ordinary case-sensitive object, so look
	// up the existing key using Windows' case-insensitive environment semantics.
	if (!hasStateHome) {
		runtimeEnv.QUARTERDECK_STATE_HOME = getDefaultDogfoodStateHome(checkoutRoot, userHome);
	}
	return runtimeEnv;
}

async function main() {
	const args = parseArgs(process.argv.slice(2));
	if (!args.skipBuild) {
		console.log(`[dogfood] Building checkout at ${repoRoot}`);
		const npmBuild = resolveNpmCommand(["run", "build"]);
		const buildCode = await runCommand(npmBuild.command, npmBuild.args, {
			cwd: repoRoot,
			env: process.env,
		});
		if (buildCode !== 0) {
			return buildCode;
		}
	}

	const cliEntrypoint = resolve(repoRoot, "dist/cli.js");
	const launchArgs = ["--port", args.port];
	if (args.noOpen) {
		launchArgs.push("--no-open");
	}
	const launchCwd = args.project ?? tmpdir();

	console.log(`[dogfood] Launching ${cliEntrypoint}`);
	if (args.project) {
		console.log(`[dogfood] Target project: ${args.project}`);
	} else {
		console.log(`[dogfood] No --project provided; launching from non-git cwd ${launchCwd}`);
		console.log("[dogfood] Quarterdeck will open the first indexed project if one exists.");
	}
	console.log(`[dogfood] Runtime port: ${args.port}`);

	return await runRuntimeCommand(nodeBinary, [cliEntrypoint, ...launchArgs], {
		cwd: launchCwd,
		env: buildDogfoodRuntimeEnv(process.env),
		stdio: ["pipe", "inherit", "inherit"],
	});
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	main()
		.then((exitCode) => {
			process.exit(exitCode);
		})
		.catch((error) => {
			const message = error instanceof Error ? error.message : String(error);
			console.error(`[dogfood] ${message}`);
			process.exit(1);
		});
}
