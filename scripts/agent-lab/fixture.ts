import { execFile } from "node:child_process";
import { chmod, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";

import type { AgentLabLaunchConfig } from "./types";

const execFileAsync = promisify(execFile);

export interface AgentLabFixturePaths {
	homePath: string;
	statePath: string;
	projectPath: string;
	fakeBinPath: string;
	browserConfigPath: string;
}

async function runGit(projectPath: string, args: string[]): Promise<void> {
	await execFileAsync("git", args, {
		cwd: projectPath,
		encoding: "utf8",
		env: {
			PATH: process.env.PATH,
			GIT_CONFIG_NOSYSTEM: "1",
			GIT_TERMINAL_PROMPT: "0",
		},
	});
}

async function writeFakeCodexLaunchers(fakeBinPath: string): Promise<void> {
	const shellLauncherPath = join(fakeBinPath, "codex");
	const windowsLauncherPath = join(fakeBinPath, "codex.cmd");
	await writeFile(
		shellLauncherPath,
		'#!/bin/sh\nexec "$QUARTERDECK_AGENT_LAB_NODE" "$QUARTERDECK_AGENT_LAB_TSX_CLI" "$QUARTERDECK_AGENT_LAB_FAKE_CODEX" "$@"\n',
		"utf8",
	);
	await chmod(shellLauncherPath, 0o755);
	await writeFile(
		windowsLauncherPath,
		'@echo off\r\n"%QUARTERDECK_AGENT_LAB_NODE%" "%QUARTERDECK_AGENT_LAB_TSX_CLI%" "%QUARTERDECK_AGENT_LAB_FAKE_CODEX%" %*\r\n',
		"utf8",
	);
}

export async function prepareAgentLabFixture(
	config: AgentLabLaunchConfig,
	webUrl: string,
): Promise<AgentLabFixturePaths> {
	const homePath = join(config.tempRoot, "home");
	const statePath = join(config.tempRoot, "state");
	const projectPath = join(config.tempRoot, "project");
	const fakeBinPath = join(config.tempRoot, "bin");
	const browserConfigPath = join(config.artifactDir, "playwright-cli.config.json");
	const browserInitPath = join(config.artifactDir, "browser-init.js");
	const browserOutputPath = join(config.artifactDir, "browser");
	await Promise.all([
		mkdir(homePath, { recursive: true }),
		mkdir(statePath, { recursive: true }),
		mkdir(projectPath, { recursive: true }),
		mkdir(fakeBinPath, { recursive: true }),
		mkdir(browserOutputPath, { recursive: true }),
		writeFile(join(config.tempRoot, "empty-gitconfig"), "", "utf8"),
	]);

	await Promise.all([
		writeFile(
			join(projectPath, "README.md"),
			"# Quarterdeck agent lab fixture\n\nThis repository is disposable and exists only for functional testing.\n",
			"utf8",
		),
		writeFile(
			join(projectPath, "example.ts"),
			'export function greeting(name: string): string {\n\treturn "Hello, " + name;\n}\n',
			"utf8",
		),
		writeFile(join(statePath, "config.json"), `${JSON.stringify({ selectedAgentId: "codex" }, null, 2)}\n`, "utf8"),
		writeFile(
			browserInitPath,
			`try {
	if (location.hostname === "127.0.0.1" || location.hostname === "localhost") {
		localStorage.setItem("quarterdeck.onboarding.dialog.shown", "true");
		localStorage.setItem("quarterdeck.onboarding.tips.dismissed", "true");
		localStorage.removeItem("quarterdeck-active-tab");
	}
} catch {
	// about:blank does not expose localStorage; the script runs again on navigation.
}
`,
			"utf8",
		),
		writeFile(
			browserConfigPath,
			`${JSON.stringify(
				{
					browser: {
						browserName: "chromium",
						isolated: true,
						launchOptions: { headless: true },
						contextOptions: { viewport: { width: 1440, height: 900 } },
						initScript: [browserInitPath],
					},
					outputDir: browserOutputPath,
					outputMode: "file",
					console: { level: "debug" },
					network: {
						allowedOrigins: [webUrl, "http://127.0.0.1:*", "ws://127.0.0.1:*"],
					},
				},
				null,
				2,
			)}\n`,
			"utf8",
		),
	]);
	await writeFakeCodexLaunchers(fakeBinPath);
	await runGit(projectPath, ["init", "-b", "main"]);
	await runGit(projectPath, ["config", "user.email", "agent-lab@example.invalid"]);
	await runGit(projectPath, ["config", "user.name", "Quarterdeck Agent Lab"]);
	await runGit(projectPath, ["add", "README.md", "example.ts"]);
	await runGit(projectPath, ["commit", "-m", "seed agent-lab fixture"]);

	return { homePath, statePath, projectPath, fakeBinPath, browserConfigPath };
}
