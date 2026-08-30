import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { terminateProcessTree } from "./process-tree.mjs";
import { mergeProcessEnvironment } from "./process-environment.mjs";

const START_TIMEOUT_MS = 15_000;
const STOP_TIMEOUT_MS = 10_000;

function waitForStart(child) {
	return new Promise((resolveStart, rejectStart) => {
		let stdout = "";
		let stderr = "";
		let settled = false;
		const timeout = setTimeout(() => {
			if (settled) return;
			settled = true;
			rejectStart(new Error(`Timed out launching packaged CLI.\nstdout:\n${stdout}\nstderr:\n${stderr}`));
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
					`Packaged CLI exited before startup (code=${String(code)} signal=${String(signal)}).\nstdout:\n${stdout}\nstderr:\n${stderr}`,
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

if (process.platform !== "win32") {
	console.error("The packaged CLI Windows smoke must run on Windows.");
	process.exitCode = 1;
} else {
	const repoRoot = resolve(import.meta.dirname, "..");
	const cliEntrypoint = resolve(repoRoot, "dist", "cli.js");
	if (!existsSync(cliEntrypoint)) {
		console.error("dist/cli.js is missing. Run `npm run build` before the native Windows smoke.");
		process.exitCode = 1;
	} else {
		const tempHome = mkdtempSync(join(tmpdir(), "quarterdeck-windows-packaged-home-"));
		const tempCwd = mkdtempSync(join(tmpdir(), "quarterdeck-windows-packaged-cwd-"));
		const child = spawn(process.execPath, [cliEntrypoint, "--no-open", "--no-native-ui", "--port", "auto"], {
			cwd: tempCwd,
			env: mergeProcessEnvironment(process.env, {
				HOME: tempHome,
				USERPROFILE: tempHome,
				QUARTERDECK_STATE_HOME: join(tempHome, ".quarterdeck"),
			}),
			stdio: ["pipe", "pipe", "pipe"],
			windowsHide: true,
		});

		try {
			const runtimeUrl = await waitForStart(child);
			const response = await fetch(runtimeUrl, { signal: AbortSignal.timeout(START_TIMEOUT_MS) });
			if (!response.ok) {
				throw new Error(`Packaged CLI returned HTTP ${response.status} for its project URL.`);
			}
			if (!(response.headers.get("content-type") ?? "").startsWith("text/html")) {
				throw new Error("Packaged CLI project URL did not return an HTML document.");
			}
			const document = await response.text();
			if (!document.includes('<div id="root"></div>')) {
				throw new Error("Packaged CLI project URL did not return the bundled Quarterdeck application shell.");
			}
			child.stdin?.end();
			if (!(await waitForExit(child))) {
				if (child.pid != null) terminateProcessTree(child.pid, "SIGKILL");
				await waitForExit(child);
				throw new Error("Packaged CLI did not exit after its parent-disconnect shutdown request.");
			}
			if (child.exitCode !== 143) {
				throw new Error(`Packaged CLI exited with ${String(child.exitCode)} instead of the graceful code 143.`);
			}
		} catch (error) {
			if (child.exitCode === null && child.signalCode === null) {
				if (child.pid != null) terminateProcessTree(child.pid, "SIGKILL");
				await waitForExit(child);
			}
			console.error(error instanceof Error ? error.message : String(error));
			process.exitCode = 1;
		} finally {
			rmSync(tempCwd, { recursive: true, force: true, maxRetries: 15, retryDelay: 300 });
			rmSync(tempHome, { recursive: true, force: true, maxRetries: 15, retryDelay: 300 });
		}
	}
}
