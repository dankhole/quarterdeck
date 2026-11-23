import { execFile } from "node:child_process";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";

import { spawn } from "node-pty";
import { describe, expect, it } from "vitest";
import { getFakeAgentVersionOutput } from "../../scripts/agent-lab/fake-agent-protocol";
import { requireInstalledWindowsFakeAgentNode, writeAgentProviderLaunchers } from "../../scripts/agent-lab/fixture";
import {
	buildWindowsCmdArgsCommandLine,
	resolveWindowsCompatibleCommand,
	resolveWindowsComSpec,
} from "../../src/core/windows-cmd-launch";

const execFileAsync = promisify(execFile);

function installedWindowsFakeAgentEnvironment(root: string) {
	return {
		...Object.fromEntries(Object.entries(process.env).filter(([key]) => key.toUpperCase() !== "PATH")),
		PATH: dirname(process.execPath),
		QUARTERDECK_AGENT_LAB_NODE: join(root, "nonexistent-explicit-node.exe"),
		QUARTERDECK_AGENT_LAB_TSX_CLI: join(root, "synthetic-tsx.cjs"),
		QUARTERDECK_AGENT_LAB_FAKE_AGENT: join(root, "synthetic-agent.ts"),
	};
}

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
				const env = installedWindowsFakeAgentEnvironment(root);
				await writeFile(env.QUARTERDECK_AGENT_LAB_TSX_CLI, "console.log(JSON.stringify(process.argv.slice(2)));\n");
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
				// Probe and Node-path checks use execFile; quoted task argv is covered through ConPTY below.
				const args = ["resume", "exact-session-id", "synthetic prompt with spaces"];
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
				expect(JSON.parse((await run(args)).stdout)).toEqual([env.QUARTERDECK_AGENT_LAB_FAKE_AGENT, ...args]);
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

	it.runIf(process.platform === "win32")(
		"forwards quoted Codex task settings, exact resume id, prompt and hook paths through the installed ConPTY launcher",
		async () => {
			const root = await mkdtemp(join(tmpdir(), "quarterdeck fake conpty-"));
			try {
				const env = {
					...installedWindowsFakeAgentEnvironment(root),
					QUARTERDECK_AGENT_LAB_HOOK_NODE: process.execPath,
					QUARTERDECK_AGENT_LAB_CLI_ENTRYPOINT: join(root, "packaged runtime", "dist", "hooks.js"),
				};
				await requireInstalledWindowsFakeAgentNode(root, process.execPath);
				await writeFile(
					env.QUARTERDECK_AGENT_LAB_TSX_CLI,
					`require("node:fs").writeFileSync("argv.json", JSON.stringify({
						args: process.argv.slice(2),
						provider: process.env.QUARTERDECK_AGENT_LAB_PROVIDER,
						hookNode: process.env.QUARTERDECK_AGENT_LAB_HOOK_NODE,
						hookEntrypoint: process.env.QUARTERDECK_AGENT_LAB_CLI_ENTRYPOINT,
					}));`,
				);
				const args = [
					"-c",
					'developer_instructions="Stay in the synthetic worktree."',
					"resume",
					"exact-session-id",
					"Synthetic prompt with spaces.\r\nSecond line: café & stay literal.",
				];
				const command = resolveWindowsCompatibleCommand(join(root, "codex.cmd"), args, "win32", env);
				// Do not substitute execFile for node-pty: they quote the pre-escaped PowerShell argv differently.
				const terminal = spawn(command.binary, command.commandLine ?? command.args, {
					cwd: root,
					env,
					cols: 180,
					rows: 40,
				});
				const timeout = setTimeout(() => terminal.kill(), 6_000);
				try {
					const result = await new Promise<{ exitCode: number }>((resolve) => terminal.onExit(resolve));
					expect(result.exitCode).toBe(0);
					// The receiver writes actual Node argv, independent of ConPTY redraw and terminal output.
					expect(JSON.parse(await readFile(join(root, "argv.json"), "utf8"))).toEqual({
						args: [env.QUARTERDECK_AGENT_LAB_FAKE_AGENT, ...args],
						provider: "codex",
						hookNode: env.QUARTERDECK_AGENT_LAB_HOOK_NODE,
						hookEntrypoint: env.QUARTERDECK_AGENT_LAB_CLI_ENTRYPOINT,
					});
				} finally {
					clearTimeout(timeout);
				}
			} finally {
				await rm(root, { recursive: true, force: true });
			}
		},
		10_000,
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
