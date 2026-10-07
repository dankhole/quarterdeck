import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { describe, expect, it } from "vitest";
import { getFakeAgentVersionOutput } from "../../scripts/agent-lab/fake-agent-protocol";
import { writeAgentProviderLaunchers } from "../../scripts/agent-lab/fixture";
import { resolveWindowsCompatibleCommand } from "../../src/core/windows-cmd-launch";

const execFileAsync = promisify(execFile);

describe("synthetic agent launcher availability", () => {
	it.each(["codex", "pi", "claude"] as const)("answers %s probes without Node or TSX", async (provider) => {
		const root = await mkdtemp(join(tmpdir(), "quarterdeck-fake-probe-"));
		try {
			await writeAgentProviderLaunchers(root, { mode: provider === "claude" ? "fake-claude" : "fake" });
			const launcher = join(root, provider);
			const env = {
				...process.env,
				QUARTERDECK_AGENT_LAB_NODE: join(root, "nonexistent-node"),
				QUARTERDECK_AGENT_LAB_TSX_CLI: join(root, "nonexistent-tsx"),
				QUARTERDECK_AGENT_LAB_FAKE_AGENT: join(root, "nonexistent-agent"),
			};
			for (const args of [["--version"], ["version"], ["features", "list"]]) {
				const command = resolveWindowsCompatibleCommand(launcher, args, process.platform, env);
				const result = await execFileAsync(command.binary, command.args, { env, timeout: 3_000 });
				expect(result.stdout.trim()).toBe(
					args[0] === "features"
						? "hooks                                stable             true"
						: getFakeAgentVersionOutput(provider),
				);
				expect(result.stderr).toBe("");
			}
			const powershell = await readFile(join(root, `${provider}.ps1`), "utf8");
			expect(powershell).toContain(getFakeAgentVersionOutput(provider));
			expect(powershell).toContain("$env:QUARTERDECK_AGENT_LAB_FAKE_AGENT @args");
			expect(powershell).not.toContain("QUARTERDECK_AGENT_LAB_FAKE_CODEX");
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	it("forwards task arguments and provider identity to the synthetic TUI", async () => {
		const root = await mkdtemp(join(tmpdir(), "quarterdeck-fake-launch-"));
		try {
			await writeAgentProviderLaunchers(root, { mode: "fake" });
			const cliPath = join(root, "synthetic-tsx.cjs");
			await writeFile(
				cliPath,
				"console.log(JSON.stringify({args:process.argv.slice(2),provider:process.env.QUARTERDECK_AGENT_LAB_PROVIDER}));\n",
			);
			const env = {
				...process.env,
				QUARTERDECK_AGENT_LAB_NODE: process.execPath,
				QUARTERDECK_AGENT_LAB_TSX_CLI: cliPath,
				QUARTERDECK_AGENT_LAB_FAKE_AGENT: join(root, "synthetic-agent.ts"),
			};
			const args = ["--no-daemon", "--", "synthetic prompt with spaces"];
			const command = resolveWindowsCompatibleCommand(join(root, "codex"), args, process.platform, env);
			const result = await execFileAsync(command.binary, command.args, { env, timeout: 3_000 });
			expect(JSON.parse(result.stdout)).toEqual({
				args: [env.QUARTERDECK_AGENT_LAB_FAKE_AGENT, ...args],
				provider: "codex",
			});
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});
});
