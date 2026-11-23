import { execFile } from "node:child_process";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";

import { describe, expect, it } from "vitest";
import { getFakeAgentVersionOutput } from "../../scripts/agent-lab/fake-agent-protocol";
import { requireInstalledWindowsFakeAgentNode, writeAgentProviderLaunchers } from "../../scripts/agent-lab/fixture";
import {
	buildWindowsCmdArgsCommandLine,
	resolveWindowsCompatibleCommand,
	resolveWindowsComSpec,
} from "../../src/core/windows-cmd-launch";

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
			expect(powershell).toContain("[Console]::Out.WriteLine($response)");
			expect(powershell).not.toContain("Save-ProbePhase");
			expect(powershell).toContain("$env:QUARTERDECK_AGENT_LAB_FAKE_AGENT @args");
			expect(powershell).not.toContain("QUARTERDECK_AGENT_LAB_FAKE_CODEX");
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	it.runIf(process.platform === "win32").each(["cmd", "powershell"] as const)(
		"requires the exact bundled Node from PATH in the installed Windows %s launcher",
		async (shell) => {
			const root = await mkdtemp(join(tmpdir(), "quarterdeck fake path-"));
			try {
				await writeAgentProviderLaunchers(root, { mode: "fake" });
				const entry = join(root, "synthetic-tsx.cjs");
				const fakeAgent = join(root, "synthetic-agent.ts");
				await writeFile(entry, "console.log(JSON.stringify(process.argv.slice(2)));\n");
				const env = {
					...Object.fromEntries(Object.entries(process.env).filter(([key]) => key.toUpperCase() !== "PATH")),
					PATH: dirname(process.execPath),
					QUARTERDECK_AGENT_LAB_NODE: join(root, "nonexistent-explicit-node.exe"),
					QUARTERDECK_AGENT_LAB_TSX_CLI: entry,
					QUARTERDECK_AGENT_LAB_FAKE_AGENT: fakeAgent,
				};
				const launcher = join(root, "codex.cmd");
				function run(args: string[], path = env.PATH) {
					const procEnv = { ...env, PATH: path };
					const options = { cwd: root, env: procEnv, timeout: 5_000, windowsHide: true };
					const command =
						shell === "cmd"
							? {
									binary: resolveWindowsComSpec(procEnv),
									args: [buildWindowsCmdArgsCommandLine(launcher, args)],
								}
							: resolveWindowsCompatibleCommand(launcher, args, "win32", procEnv);
					const result = execFileAsync(command.binary, command.args, {
						...options,
						windowsVerbatimArguments: shell === "cmd",
					});
					result.child.stdin?.end();
					return result;
				}
				const args = [
					...(shell === "powershell" ? ["-c", 'developer_instructions="Stay in the synthetic worktree."'] : []),
					"resume",
					"exact-session-id",
					"synthetic prompt with spaces",
				];
				const artifactDir = join(root, "lab's réceipts");
				const probeDir = join(artifactDir, "windows-fake-agent-probes");
				await requireInstalledWindowsFakeAgentNode(root, process.execPath, artifactDir);
				for (const [probeArgs, output] of [
					[["--version"], getFakeAgentVersionOutput("codex")],
					[["features", "list"], "hooks                                stable             true"],
				] satisfies [string[], string][]) {
					const result = await run(probeArgs, "");
					expect(result.stdout.trim()).toBe(output);
					expect(result.stderr).toBe("");
				}
				await expect(run(args, "")).rejects.toMatchObject({ stdout: "" });
				expect(JSON.parse((await run(args)).stdout)).toEqual([fakeAgent, ...args]);
				if (shell === "powershell") {
					expect((await readdir(probeDir)).sort()).toEqual(["codex-features.txt", "codex-version.txt"]);
					for (const name of ["codex-features.txt", "codex-version.txt"]) {
						const receipt = await readFile(join(probeDir, name), "utf8");
						expect(receipt).toMatch(/^\d{4}-\d\d-\d\dT\S+Z\t[1-9]\d*\tstdout-flushed$/u);
					}
					await rm(probeDir, { recursive: true });
					const withoutReceipt = await run(["--version"], "");
					expect(withoutReceipt.stdout.trim()).toBe(getFakeAgentVersionOutput("codex"));
					expect(withoutReceipt.stderr).toBe("");
				} else {
					expect(await readdir(probeDir)).toEqual([]);
				}

				// The same working PATH Node must be rejected when it isn't this installation's Node.
				const otherNode = join(root, "other-node.exe");
				await writeFile(otherNode, "not the PATH Node");
				await requireInstalledWindowsFakeAgentNode(root, otherNode);
				await expect(run(args)).rejects.toMatchObject({
					stderr: expect.stringContaining("did not resolve the installed bundled node.exe from PATH"),
					stdout: "",
				});
			} finally {
				await rm(root, { recursive: true, force: true });
			}
		},
	);

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
