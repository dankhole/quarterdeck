import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createGitTestEnv } from "../utilities/git-env.js";
import { resolveIntegrationNodeArgs } from "../utilities/integration-server";
import { createTempDir } from "../utilities/temp-dir.js";

function expectRejectedLaunch(
	args: string[],
	message: string,
	desktopHelper: boolean,
	env: NodeJS.ProcessEnv = {},
): void {
	const sandbox = createTempDir("quarterdeck-cli-modes-");
	const stateHome = join(sandbox.path, "state");
	try {
		const child = spawnSync(process.execPath, [...resolveIntegrationNodeArgs(), ...args], {
			cwd: sandbox.path,
			env: createGitTestEnv({
				HOME: sandbox.path,
				USERPROFILE: sandbox.path,
				QUARTERDECK_STATE_HOME: stateHome,
				QUARTERDECK_DESKTOP_CHILD: desktopHelper ? "1" : undefined,
				CI: "true",
				...env,
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
}

describe("CLI launch mode routing", () => {
	it.each([
		{ args: ["--desktop", "--browser"], message: "unknown option '--browser'" },
		{ args: ["--no-open"], message: "unknown option '--no-open'" },
		{ args: ["--desktop", "--internal-runtime"], message: "cannot be used with option" },
		{ args: ["--desktop", "--port", "auto"], message: "cannot be used with option" },
		{ args: ["--internal-runtime", "desktop", "install"], message: "cannot be combined with subcommands" },
		{ args: ["--internal-runtime"], message: "native installation admission bootstrap" },
		{ args: ["desktop", "install", "--desktop"], message: "cannot be combined with subcommands" },
		{
			args: ["--desktop"],
			message: "A desktop runtime helper requires --internal-runtime",
		},
	])("rejects $args before installation or runtime startup", ({ args, message }) => {
		expectRejectedLaunch(args, message, true);
	});
	it("cannot open the user's desktop app from an ordinary source test invocation", () => {
		expectRejectedLaunch(
			[],
			["darwin", "win32"].includes(process.platform) ? "local graphical session" : "macOS 13+",
			false,
		);
	});
	it.each(["0.0.0.0", "::", "192.168.1.10", "localhost"])(
		"rejects internal host %s before runtime state is created",
		(host) => {
			expectRejectedLaunch(["--internal-runtime", "--host", host], "bind only to 127.0.0.1", false, {
				QUARTERDECK_AGENT_LAB: "1",
			});
		},
	);
	it("applies the same loopback-only restriction to the runtime host environment", () => {
		expectRejectedLaunch(["--internal-runtime"], "bind only to 127.0.0.1", false, {
			QUARTERDECK_AGENT_LAB: "1",
			QUARTERDECK_RUNTIME_HOST: "0.0.0.0",
		});
	});
	it("does not treat runtime flags as a runtime launch", () => {
		expectRejectedLaunch(["--port", "auto"], "Runtime options require", false);
	});
	it.skipIf(process.platform !== "linux")("rejects unsupported desktop hosts outside a helper", () => {
		expectRejectedLaunch(["--desktop"], "macOS 13+", false);
	});
});
