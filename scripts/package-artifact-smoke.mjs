import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { resolveNpmCommand } from "./npm-command.mjs";
import { fetchInstalledApplication, readInstalledBrowserBootstrap } from "./package-smoke-client.mjs";
import { mergeProcessEnvironment } from "./process-environment.mjs";
import { terminateProcessTree } from "./process-tree.mjs";

const START_TIMEOUT_MS = 15_000;
const STOP_TIMEOUT_MS = 10_000;

function runNpm(args, cwd, env, captureOutput = false) {
	const invocation = resolveNpmCommand(args, { env });
	const result = spawnSync(invocation.command, invocation.args, {
		cwd,
		env,
		encoding: captureOutput ? "utf8" : undefined,
		stdio: captureOutput ? ["ignore", "pipe", "pipe"] : "inherit",
		windowsHide: true,
	});
	if (result.error) throw result.error;
	if (result.status !== 0) {
		const stderr = captureOutput ? `\n${String(result.stderr).trim()}` : "";
		throw new Error(`npm ${args.join(" ")} failed with exit code ${result.status ?? "unknown"}.${stderr}`);
	}
	return captureOutput ? String(result.stdout) : "";
}

function waitForStart(child) {
	return new Promise((resolveStart, rejectStart) => {
		let stdout = "";
		let settled = false;
		const timeout = setTimeout(() => {
			if (settled) return;
			settled = true;
			rejectStart(new Error("Timed out launching installed CLI."));
		}, START_TIMEOUT_MS);
		const inspect = (chunk) => {
			stdout = (stdout + String(chunk)).slice(-64 * 1024);
			const runtimeUrl = readInstalledBrowserBootstrap(stdout);
			if (settled || !runtimeUrl) return;
			settled = true;
			clearTimeout(timeout);
			resolveStart(runtimeUrl);
		};
		child.stdout?.on("data", inspect);
		// Drain stderr without exposing startup capabilities or credential-bearing errors.
		child.stderr?.on("data", () => {});
		child.once("error", () => {
			if (settled) return;
			settled = true;
			clearTimeout(timeout);
			rejectStart(new Error("Installed CLI process could not be launched."));
		});
		child.once("exit", (code, signal) => {
			if (settled) return;
			settled = true;
			clearTimeout(timeout);
			rejectStart(new Error(`Installed CLI exited before startup (code=${String(code)} signal=${String(signal)}).`));
		});
	});
}

function waitForExit(child) {
	if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve(true);
	return new Promise((resolveExit) => {
		const timeout = setTimeout(() => {
			child.removeListener("exit", handleExit);
			resolveExit(false);
		}, STOP_TIMEOUT_MS);
		const handleExit = () => {
			clearTimeout(timeout);
			resolveExit(true);
		};
		child.once("exit", handleExit);
	});
}

function resolveInstalledCli(installRoot) {
	const packageRoot =
		process.platform === "win32"
			? join(installRoot, "node_modules", "quarterdeck")
			: join(installRoot, "lib", "node_modules", "quarterdeck");
	return join(packageRoot, "dist", "cli.js");
}

function resolveInstalledBin(installRoot) {
	return process.platform === "win32" ? join(installRoot, "quarterdeck.cmd") : join(installRoot, "bin", "quarterdeck");
}

function isDesktopDependency(name) {
	return (
		name === "quarterdeck-desktop" ||
		name === "electron" ||
		name.startsWith("electron-") ||
		name.startsWith("@electron/") ||
		name.startsWith("@electron-forge/")
	);
}

function assertCliArtifact(packRecord, manifest) {
	if (!Array.isArray(packRecord?.files) || packRecord.files.length === 0) {
		throw new Error("npm pack did not report the artifact file inventory.");
	}
	for (const file of packRecord.files) {
		if (typeof file.path !== "string" || /(^|\/)(desktop|node_modules)(\/|$)/u.test(file.path)) {
			throw new Error("The CLI tarball unexpectedly contains a desktop or dependency directory.");
		}
	}
	for (const name of Object.keys({ ...manifest.dependencies, ...manifest.optionalDependencies })) {
		if (isDesktopDependency(name)) throw new Error("The CLI manifest unexpectedly requires a desktop dependency.");
	}
}

function assertCliDependencyTree(tree) {
	for (const [name, dependency] of Object.entries(tree.dependencies ?? {})) {
		if (isDesktopDependency(name)) throw new Error("The installed CLI unexpectedly includes a desktop dependency.");
		assertCliDependencyTree(dependency);
	}
}

const repoRoot = resolve(import.meta.dirname, "..");
const packageJson = JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8"));
const smokeRoot = mkdtempSync(join(tmpdir(), "quarterdeck-package-smoke-"));
const artifactRoot = join(smokeRoot, "artifact");
const installRoot = join(smokeRoot, "install");
const stateRoot = join(smokeRoot, "state");
const projectRoot = join(smokeRoot, "project");
// A consumer-default install must not inherit the maintainer's script policy,
// npm user/global config paths, or Node module search/execution overrides.
const baseEnvironment = { ...process.env };
for (const key of Object.keys(baseEnvironment)) {
	if (
		/^(npm_config_(?:ignore_scripts|allow_scripts|dangerously_allow_all_scripts|strict_allow_scripts|userconfig|globalconfig)|NODE_PATH|NODE_OPTIONS|ELECTRON_RUN_AS_NODE)$/iu.test(
			key,
		)
	) {
		delete baseEnvironment[key];
	}
}
const smokeEnv = mergeProcessEnvironment(baseEnvironment, {
	HOME: stateRoot,
	USERPROFILE: stateRoot,
	QUARTERDECK_STATE_HOME: join(stateRoot, ".quarterdeck"),
	npm_config_cache: join(smokeRoot, "npm-cache"),
	npm_config_userconfig: join(smokeRoot, "user.npmrc"),
	npm_config_globalconfig: join(smokeRoot, "global.npmrc"),
});
let child;
let retainSmokeRoot = false;

try {
	mkdirSync(artifactRoot, { recursive: true });
	mkdirSync(projectRoot, { recursive: true });
	const packOutput = runNpm(
		["pack", "--ignore-scripts", "--json", "--pack-destination", artifactRoot],
		repoRoot,
		smokeEnv,
		true,
	);
	const packResult = JSON.parse(packOutput);
	assertCliArtifact(packResult[0], packageJson);
	const filename = packResult[0]?.filename;
	if (typeof filename !== "string" || filename.length === 0) {
		throw new Error("npm pack did not report a package artifact filename.");
	}
	const tarballPath = join(artifactRoot, filename);
	const tarballSha256 = createHash("sha256").update(readFileSync(tarballPath)).digest("hex");
	console.log(
		`Artifact ${filename} SHA-256 ${tarballSha256}; Node ${process.version}; npm ${runNpm(["--version"], repoRoot, smokeEnv, true).trim()}; default isolated npm script policy.`,
	);
	runNpm(
		["install", "--global", "--prefix", installRoot, "--package-lock=false", "--foreground-scripts", tarballPath],
		repoRoot,
		smokeEnv,
	);
	const dependencyTree = JSON.parse(
		runNpm(["ls", "--global", "--prefix", installRoot, "--all", "--omit=dev", "--json"], repoRoot, smokeEnv, true),
	);
	assertCliDependencyTree(dependencyTree);

	const installedCli = resolveInstalledCli(installRoot);
	const installedBin = resolveInstalledBin(installRoot);
	if (!existsSync(installedCli)) throw new Error("The installed package did not contain dist/cli.js.");
	if (!existsSync(installedBin)) throw new Error("The installed package did not create the quarterdeck command.");
	retainSmokeRoot = true;
	const ptyResult = spawnSync(
		process.execPath,
		[join(repoRoot, "scripts", "package-smoke-pty.mjs"), installedCli, installRoot],
		{
			cwd: projectRoot,
			env: smokeEnv,
			encoding: "utf8",
			timeout: START_TIMEOUT_MS,
			windowsHide: true,
		},
	);
	retainSmokeRoot = !ptyResult.stdout?.split(/\r?\n/u).includes("Installed PTY cleanup confirmed.");
	if (ptyResult.error || ptyResult.status !== 0 || retainSmokeRoot) {
		throw new Error(
			`The default isolated npm install cannot launch a usable native PTY. Check npm's blocked-script report and the installed node-pty assets; if script approval is required, approve only node-pty for the consumer's npm version and repeat this gate. The smoke test never automatically approves or bypasses lifecycle policy.\n${ptyResult.error?.message ?? String(ptyResult.stderr).trim()}`,
		);
	}
	console.log(ptyResult.stdout.trim());
	const versionResult = spawnSync(process.execPath, [installedCli, "--version"], {
		cwd: projectRoot,
		env: smokeEnv,
		encoding: "utf8",
		windowsHide: true,
	});
	if (versionResult.error) throw versionResult.error;
	if (versionResult.status !== 0 || versionResult.stdout.trim() !== String(packageJson.version)) {
		throw new Error(
			`Installed CLI version check failed (status=${String(versionResult.status)}, stdout=${JSON.stringify(versionResult.stdout.trim())}).`,
		);
	}

	child = spawn(process.execPath, [installedCli, "--browser", "--no-open", "--no-native-ui", "--port", "auto"], {
		cwd: projectRoot,
		env: smokeEnv,
		stdio: ["pipe", "pipe", "pipe"],
		detached: process.platform !== "win32",
		windowsHide: true,
	});
	const runtimeUrl = await waitForStart(child);
	await fetchInstalledApplication(runtimeUrl, { timeoutMs: START_TIMEOUT_MS });
	child.stdin?.end();
	if (!(await waitForExit(child))) {
		if (child.pid != null) terminateProcessTree(child.pid, "SIGKILL");
		await waitForExit(child);
		throw new Error("Installed CLI did not exit after its parent-disconnect shutdown request.");
	}
	const expectedExitCode = process.platform === "win32" ? 143 : 129;
	if (child.exitCode !== expectedExitCode) {
		throw new Error(
			`Installed CLI exited with ${String(child.exitCode)} instead of the graceful code ${expectedExitCode}.`,
		);
	}
	console.log(
		`quarterdeck package artifact ${filename} excludes desktop dependencies, installed under default npm policy, passed native PTY input/output/exit, authenticated, served the UI, and stopped cleanly`,
	);
} catch (error) {
	if (child && child.exitCode === null && child.signalCode === null) {
		if (child.pid != null) terminateProcessTree(child.pid, "SIGKILL");
		await waitForExit(child);
	}
	console.error(error instanceof Error ? error.message : String(error));
	process.exitCode = 1;
} finally {
	if (retainSmokeRoot) {
		console.error(`PTY cleanup could not be confirmed; retained isolated fixture ${smokeRoot}.`);
	} else {
		rmSync(smokeRoot, { recursive: true, force: true, maxRetries: 15, retryDelay: 300 });
		console.log(`Removed isolated package fixture ${smokeRoot}.`);
	}
}
