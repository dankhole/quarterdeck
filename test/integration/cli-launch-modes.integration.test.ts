import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createGitTestEnv } from "../utilities/git-env.js";
import { resolveIntegrationNodeArgs } from "../utilities/integration-server";
import { createTempDir } from "../utilities/temp-dir.js";

describe("CLI launch mode routing", () => {
	it.each([
		{ args: ["--desktop", "--browser"], message: "cannot be used with option" },
		{ args: ["--desktop", "--no-open"], message: "cannot be used with option" },
		{ args: ["--desktop", "--port", "auto"], message: "cannot be used with option" },
		{ args: ["--browser", "desktop", "install"], message: "cannot be combined with subcommands" },
		{ args: ["desktop", "install", "--desktop"], message: "cannot be combined with subcommands" },
		{
			args: ["--desktop"],
			message:
				process.platform === "darwin"
					? "A desktop runtime helper cannot launch another desktop app"
					: "Desktop mode is available on macOS",
		},
	])("rejects $args before installation or runtime startup", ({ args, message }) => {
		const sandbox = createTempDir("quarterdeck-cli-modes-");
		const stateHome = join(sandbox.path, "state");
		try {
			const child = spawnSync(process.execPath, [...resolveIntegrationNodeArgs(), ...args], {
				cwd: sandbox.path,
				env: createGitTestEnv({
					HOME: sandbox.path,
					USERPROFILE: sandbox.path,
					QUARTERDECK_STATE_HOME: stateHome,
					QUARTERDECK_DESKTOP_CHILD: "1",
				}),
				encoding: "utf8",
				timeout: 10_000,
			});
			expect(child.error).toBeUndefined();
			expect(child.status).toBe(1);
			expect(child.stderr).toContain(message);
			expect(existsSync(stateHome)).toBe(false);
			expect(existsSync(join(sandbox.path, "Library"))).toBe(false);
		} finally {
			sandbox.cleanup();
		}
	});
});
