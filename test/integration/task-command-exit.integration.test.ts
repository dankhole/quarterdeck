import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

import { createGitTestEnv } from "../utilities/git-env";
import { resolveIntegrationNodeArgs } from "../utilities/integration-server";
import { createTempDir } from "../utilities/temp-dir";

const execute = promisify(execFile);

describe("CLI informational commands", () => {
	it.each([
		{ flag: "--help", output: /Usage: quarterdeck/ },
		{ flag: "--version", output: /^\d+\.\d+\.\d+/ },
	])("exits for $flag even when the invocation has runtime settings", async ({ flag, output }) => {
		const sandbox = createTempDir("quarterdeck-cli-info-");
		const stateHome = join(sandbox.path, "state");
		try {
			const result = await execute(process.execPath, [...resolveIntegrationNodeArgs(), flag], {
				cwd: sandbox.path,
				env: createGitTestEnv({
					HOME: sandbox.path,
					USERPROFILE: sandbox.path,
					QUARTERDECK_STATE_HOME: stateHome,
					QUARTERDECK_RUNTIME_PORT: "3500",
					CI: "true",
				}),
				timeout: 10_000,
				windowsHide: true,
			});
			expect(result.stdout).toMatch(output);
			expect(existsSync(stateHome)).toBe(false);
		} finally {
			sandbox.cleanup();
		}
	});
});
