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
	additionalProjectPath: string;
	fakeBinPath: string;
	browserConfigPath: string;
	forbiddenHostLaunchLogPath: string;
}

const FORBIDDEN_HOST_LAUNCHERS = [
	"code",
	"code-insiders",
	"cursor",
	"explorer",
	"kdialog",
	"open",
	"osascript",
	"powershell",
	"pwsh",
	"rider",
	"windsurf",
	"xdg-open",
	"zed",
	"zenity",
] as const;

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

async function writeForbiddenHostLaunchers(fakeBinPath: string): Promise<void> {
	await Promise.all(
		FORBIDDEN_HOST_LAUNCHERS.flatMap((launcher) => {
			const shellLauncherPath = join(fakeBinPath, launcher);
			const windowsLauncherPath = join(fakeBinPath, `${launcher}.cmd`);
			return [
				writeFile(
					shellLauncherPath,
					'#!/bin/sh\nprintf "%s\\t%s\\n" "$0" "$*" >> "$QUARTERDECK_AGENT_LAB_FORBIDDEN_HOST_LAUNCH_LOG"\nexit 97\n',
					"utf8",
				).then(async () => await chmod(shellLauncherPath, 0o755)),
				writeFile(
					windowsLauncherPath,
					'@echo off\r\n>>"%QUARTERDECK_AGENT_LAB_FORBIDDEN_HOST_LAUNCH_LOG%" echo %~nx0 %*\r\nexit /b 97\r\n',
					"utf8",
				),
			];
		}),
	);
}

async function seedGitRepository(projectPath: string, label: string): Promise<void> {
	await Promise.all([
		writeFile(
			join(projectPath, "README.md"),
			`# ${label}\n\nThis repository is disposable and exists only for functional testing.\n`,
			"utf8",
		),
		writeFile(
			join(projectPath, "example.ts"),
			'export function greeting(name: string): string {\n\treturn "Hello, " + name;\n}\n',
			"utf8",
		),
	]);
	await runGit(projectPath, ["init", "-b", "main"]);
	await runGit(projectPath, ["config", "user.email", "agent-lab@example.invalid"]);
	await runGit(projectPath, ["config", "user.name", "Quarterdeck Agent Lab"]);
	await runGit(projectPath, ["add", "README.md", "example.ts"]);
	await runGit(projectPath, ["commit", "-m", "seed agent-lab fixture"]);
}

export async function prepareAgentLabFixture(
	config: AgentLabLaunchConfig,
	webUrl: string,
): Promise<AgentLabFixturePaths> {
	const homePath = join(config.tempRoot, "home");
	const statePath = join(config.tempRoot, "state");
	const projectPath = join(config.tempRoot, "project");
	const additionalProjectPath = join(config.tempRoot, "project-secondary");
	const fakeBinPath = join(config.tempRoot, "bin");
	const forbiddenHostLaunchLogPath = join(config.artifactDir, "forbidden-host-launches.log");
	const browserConfigPath = join(config.artifactDir, "playwright-cli.config.json");
	const browserInitPath = join(config.artifactDir, "browser-init.js");
	const browserOutputPath = join(config.artifactDir, "browser");
	await Promise.all([
		mkdir(homePath, { recursive: true }),
		mkdir(statePath, { recursive: true }),
		mkdir(projectPath, { recursive: true }),
		mkdir(additionalProjectPath, { recursive: true }),
		mkdir(fakeBinPath, { recursive: true }),
		mkdir(browserOutputPath, { recursive: true }),
		writeFile(join(config.tempRoot, "empty-gitconfig"), "", "utf8"),
		writeFile(forbiddenHostLaunchLogPath, "", "utf8"),
	]);

	await Promise.all([
		writeFile(
			join(statePath, "config.json"),
			`${JSON.stringify({ selectedAgentId: "codex", logLevel: "debug" }, null, 2)}\n`,
			"utf8",
		),
		writeFile(
			browserInitPath,
			`try {
	if (location.hostname === "127.0.0.1" || location.hostname === "localhost") {
		window.__quarterdeckAgentLab = ${JSON.stringify({ additionalProjectPath })};
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
	await Promise.all([writeFakeCodexLaunchers(fakeBinPath), writeForbiddenHostLaunchers(fakeBinPath)]);
	await Promise.all([
		seedGitRepository(projectPath, "Quarterdeck agent lab fixture"),
		seedGitRepository(additionalProjectPath, "Quarterdeck agent lab secondary fixture"),
	]);

	return {
		homePath,
		statePath,
		projectPath,
		additionalProjectPath,
		fakeBinPath,
		browserConfigPath,
		forbiddenHostLaunchLogPath,
	};
}
