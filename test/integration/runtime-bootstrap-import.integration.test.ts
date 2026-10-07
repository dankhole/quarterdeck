import { spawn } from "node:child_process";
import { once } from "node:events";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { describe, expect, it } from "vitest";

import { createGitTestEnv } from "../utilities/git-env";
import { resolveTsxLoaderImportSpecifier } from "../utilities/integration-server";
import { createTempDir } from "../utilities/temp-dir";

describe("runtime bootstrap import safety", () => {
	it.each(["shared-module", "hook-subcommand"])("creates no runtime state or active handles for %s", async (entry) => {
		const sandbox = createTempDir("quarterdeck-bootstrap-import-");
		const stateHome = join(sandbox.path, "state");
		const moduleUrl = pathToFileURL(resolve("src/server/runtime-bootstrap.ts")).href;
		const args =
			entry === "shared-module"
				? [
						"--input-type=module",
						"--eval",
						`import { startRuntime } from ${JSON.stringify(moduleUrl)}; console.log(typeof startRuntime);`,
					]
				: [resolve("src/cli.ts"), "hooks", "notify", "--event", "activity"];
		const child = spawn(process.execPath, ["--import", resolveTsxLoaderImportSpecifier(), ...args], {
			env: createGitTestEnv({
				HOME: sandbox.path,
				USERPROFILE: sandbox.path,
				QUARTERDECK_STATE_HOME: stateHome,
				QUARTERDECK_HOOK_TASK_ID: "",
				QUARTERDECK_HOOK_PROJECT_ID: "",
			}),
			stdio: ["ignore", "pipe", "pipe"],
		});
		let stdout = "";
		let stderr = "";
		child.stdout.on("data", (chunk: Buffer) => {
			stdout += chunk.toString();
		});
		child.stderr.on("data", (chunk: Buffer) => {
			stderr += chunk.toString();
		});
		const closed = once(child, "close");
		const timeout = setTimeout(() => child.kill("SIGKILL"), 8_000);
		try {
			const [code, signal] = await closed;
			expect({ code, signal, stderr }).toEqual({ code: 0, signal: null, stderr: "" });
			expect(stdout.trim()).toBe(entry === "shared-module" ? "function" : "");
			expect(existsSync(stateHome)).toBe(false);
		} finally {
			clearTimeout(timeout);
			if (child.exitCode === null && child.signalCode === null) {
				child.kill("SIGKILL");
				await closed;
			}
			sandbox.cleanup();
		}
	});
});
