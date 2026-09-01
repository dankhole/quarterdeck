import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { resolveNpmCommand } from "./npm-command.mjs";
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
		let stderr = "";
		let settled = false;
		const timeout = setTimeout(() => {
			if (settled) return;
			settled = true;
			rejectStart(new Error(`Timed out launching installed CLI.\nstdout:\n${stdout}\nstderr:\n${stderr}`));
		}, START_TIMEOUT_MS);
		const inspect = (chunk, source) => {
			if (source === "stdout") stdout += String(chunk);
			else stderr += String(chunk);
			const runtimeUrl = stdout.match(/Quarterdeck running at (http:\/\/127\.0\.0\.1:\d+\S*)/u)?.[1];
			if (settled || !runtimeUrl) return;
			settled = true;
			clearTimeout(timeout);
			resolveStart(runtimeUrl);
		};
		child.stdout?.on("data", (chunk) => inspect(chunk, "stdout"));
		child.stderr?.on("data", (chunk) => inspect(chunk, "stderr"));
		child.once("exit", (code, signal) => {
			if (settled) return;
			settled = true;
			clearTimeout(timeout);
			rejectStart(
				new Error(
					`Installed CLI exited before startup (code=${String(code)} signal=${String(signal)}).\nstdout:\n${stdout}\nstderr:\n${stderr}`,
				),
			);
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
	return process.platform === "win32"
		? join(installRoot, "quarterdeck.cmd")
		: join(installRoot, "bin", "quarterdeck");
}

const repoRoot = resolve(import.meta.dirname, "..");
const packageJson = JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8"));
const smokeRoot = mkdtempSync(join(tmpdir(), "quarterdeck-package-smoke-"));
const artifactRoot = join(smokeRoot, "artifact");
const installRoot = join(smokeRoot, "install");
const stateRoot = join(smokeRoot, "state");
const projectRoot = join(smokeRoot, "project");
const smokeEnv = mergeProcessEnvironment(process.env, {
	HOME: stateRoot,
	USERPROFILE: stateRoot,
	QUARTERDECK_STATE_HOME: join(stateRoot, ".quarterdeck"),
	npm_config_cache: join(smokeRoot, "npm-cache"),
});
let child;

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
	const filename = packResult[0]?.filename;
	if (typeof filename !== "string" || filename.length === 0) {
		throw new Error("npm pack did not report a package artifact filename.");
	}
	const tarballPath = join(artifactRoot, filename);
	runNpm(["install", "--global", "--prefix", installRoot, "--package-lock=false", tarballPath], repoRoot, smokeEnv);

	const installedCli = resolveInstalledCli(installRoot);
	const installedBin = resolveInstalledBin(installRoot);
	if (!existsSync(installedCli)) throw new Error("The installed package did not contain dist/cli.js.");
	if (!existsSync(installedBin)) throw new Error("The installed package did not create the quarterdeck command.");
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

	child = spawn(process.execPath, [installedCli, "--no-open", "--no-native-ui", "--port", "auto"], {
		cwd: projectRoot,
		env: smokeEnv,
		stdio: ["pipe", "pipe", "pipe"],
		windowsHide: true,
	});
	const runtimeUrl = await waitForStart(child);
	const response = await fetch(runtimeUrl, { signal: AbortSignal.timeout(START_TIMEOUT_MS) });
	if (!response.ok) throw new Error(`Installed CLI returned HTTP ${response.status} for its project URL.`);
	if (!(response.headers.get("content-type") ?? "").startsWith("text/html")) {
		throw new Error("Installed CLI project URL did not return an HTML document.");
	}
	const document = await response.text();
	if (!document.includes('<div id="root"></div>')) {
		throw new Error("Installed CLI project URL did not return the bundled Quarterdeck application shell.");
	}
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
	console.log(`quarterdeck package artifact ${filename} installed, launched, served the UI, and stopped cleanly`);
} catch (error) {
	if (child && child.exitCode === null && child.signalCode === null) {
		if (child.pid != null) terminateProcessTree(child.pid, "SIGKILL");
		await waitForExit(child);
	}
	console.error(error instanceof Error ? error.message : String(error));
	process.exitCode = 1;
} finally {
	rmSync(smokeRoot, { recursive: true, force: true, maxRetries: 15, retryDelay: 300 });
}
