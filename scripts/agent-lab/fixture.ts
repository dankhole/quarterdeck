import { execFile } from "node:child_process";
import { chmod, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";

import type { RuntimeHostSimulationConfig } from "../../src/server/runtime-host-simulation";
import { resolveAgentLabProviderPolicy } from "./provider-policy";
import { AGENT_LAB_REAL_CLAUDE_ENVIRONMENT_POLICY } from "./real-claude";
import { AGENT_LAB_REAL_CODEX_CONFIG_OVERRIDES } from "./real-codex";
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
	hostEventLedgerPath: string;
	hostSimulationConfigPath: string;
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

async function writeFakeAgentLaunchers(fakeBinPath: string, provider: "claude" | "codex" | "pi"): Promise<void> {
	const shellLauncherPath = join(fakeBinPath, provider);
	const windowsLauncherPath = join(fakeBinPath, `${provider}.cmd`);
	await writeFile(
		shellLauncherPath,
		`#!/bin/sh\nQUARTERDECK_AGENT_LAB_PROVIDER=${provider} exec "$QUARTERDECK_AGENT_LAB_NODE" "$QUARTERDECK_AGENT_LAB_TSX_CLI" "$QUARTERDECK_AGENT_LAB_FAKE_AGENT" "$@"\n`,
		"utf8",
	);
	await chmod(shellLauncherPath, 0o755);
	await writeFile(
		windowsLauncherPath,
		`@echo off\r\nset "QUARTERDECK_AGENT_LAB_PROVIDER=${provider}"\r\n"%QUARTERDECK_AGENT_LAB_NODE%" "%QUARTERDECK_AGENT_LAB_TSX_CLI%" "%QUARTERDECK_AGENT_LAB_FAKE_AGENT%" %*\r\n`,
		"utf8",
	);
}

async function writeBlockedAgentLaunchers(fakeBinPath: string, provider: "claude" | "codex" | "pi"): Promise<void> {
	const message = `Agent Lab does not enable ${provider} in this provider mode.`;
	const shellLauncherPath = join(fakeBinPath, provider);
	const windowsLauncherPath = join(fakeBinPath, `${provider}.cmd`);
	await writeFile(shellLauncherPath, `#!/bin/sh\nprintf "%s\\n" "${message}" >&2\nexit 127\n`, "utf8");
	await chmod(shellLauncherPath, 0o755);
	await writeFile(windowsLauncherPath, `@echo off\r\necho ${message} 1>&2\r\nexit /b 127\r\n`, "utf8");
}

export async function writeRealCodexLauncher(fakeBinPath: string): Promise<void> {
	const shellLauncherPath = join(fakeBinPath, "codex");
	const windowsLauncherPath = join(fakeBinPath, "codex.cmd");
	const policyArguments = AGENT_LAB_REAL_CODEX_CONFIG_OVERRIDES.flatMap((value) => ["-c", value]);
	const shellPolicyArguments = policyArguments.map((value) => `'${value.replaceAll("'", `'"'"'`)}'`).join(" ");
	const windowsPolicyArguments = policyArguments.join(" ");
	await writeFile(
		shellLauncherPath,
		[
			"#!/bin/sh",
			"set -eu",
			'real_codex_runtime_path="$PATH"',
			'real_codex_host_path="$QUARTERDECK_AGENT_LAB_REAL_CODEX_HOST_PATH"',
			'real_codex_home="$QUARTERDECK_AGENT_LAB_REAL_CODEX_HOME"',
			'real_codex_model="$QUARTERDECK_AGENT_LAB_REAL_CODEX_MODEL"',
			'real_codex_sandbox="$QUARTERDECK_AGENT_LAB_REAL_CODEX_SANDBOX"',
			'real_codex_approval_policy="$QUARTERDECK_AGENT_LAB_REAL_CODEX_APPROVAL_POLICY"',
			'real_codex_binary=$(PATH="$real_codex_host_path" command -v codex 2>/dev/null || true)',
			'if [ -z "$real_codex_binary" ]; then echo "Agent Lab could not resolve the host Codex binary." >&2; exit 127; fi',
			'export PATH="$real_codex_runtime_path"',
			'export CODEX_HOME="$real_codex_home"',
			"unset QUARTERDECK_AGENT_LAB_REAL_CODEX_HOST_PATH",
			"unset QUARTERDECK_AGENT_LAB_REAL_CODEX_HOME",
			"unset QUARTERDECK_AGENT_LAB_REAL_CODEX_MODEL",
			"unset QUARTERDECK_AGENT_LAB_REAL_CODEX_SANDBOX",
			"unset QUARTERDECK_AGENT_LAB_REAL_CODEX_APPROVAL_POLICY",
			`case "\${1-}" in`,
			"  --version|-V|features)",
			'    exec "$real_codex_binary" "$@"',
			"    ;;",
			"esac",
			"has_model=0",
			"has_sandbox=0",
			"has_approval_policy=0",
			'for argument in "$@"; do',
			'  if [ "$argument" = "--" ]; then break; fi',
			'  case "$argument" in',
			"    -m|--model|--model=*) has_model=1 ;;",
			"    -s|--sandbox|--sandbox=*) has_sandbox=1 ;;",
			"    -a|--ask-for-approval|--ask-for-approval=*) has_approval_policy=1 ;;",
			"    --approve-for-me|--not-so-yolo|--dangerously-bypass-approvals-and-sandbox|--yolo) has_sandbox=1; has_approval_policy=1 ;;",
			"  esac",
			"done",
			'if [ "$has_model" -eq 0 ]; then set -- --model "$real_codex_model" "$@"; fi',
			'if [ "$has_sandbox" -eq 0 ]; then set -- --sandbox "$real_codex_sandbox" "$@"; fi',
			'if [ "$has_approval_policy" -eq 0 ]; then set -- --ask-for-approval "$real_codex_approval_policy" "$@"; fi',
			`set -- ${shellPolicyArguments} "$@"`,
			'exec "$real_codex_binary" "$@"',
			"",
		].join("\n"),
		"utf8",
	);
	await chmod(shellLauncherPath, 0o755);
	await writeFile(
		windowsLauncherPath,
		[
			"@echo off",
			"setlocal",
			'set "QUARTERDECK_AGENT_LAB_REAL_CODEX_RUNTIME_PATH=%PATH%"',
			'set "PATH=%QUARTERDECK_AGENT_LAB_REAL_CODEX_HOST_PATH%"',
			'set "QUARTERDECK_AGENT_LAB_REAL_CODEX_BINARY="',
			'for /f "delims=" %%I in (\'where codex 2^>nul\') do if not defined QUARTERDECK_AGENT_LAB_REAL_CODEX_BINARY set "QUARTERDECK_AGENT_LAB_REAL_CODEX_BINARY=%%I"',
			"if not defined QUARTERDECK_AGENT_LAB_REAL_CODEX_BINARY (",
			"  echo Agent Lab could not resolve the host Codex binary. 1>&2",
			"  exit /b 127",
			")",
			'set "PATH=%QUARTERDECK_AGENT_LAB_REAL_CODEX_RUNTIME_PATH%"',
			'set "CODEX_HOME=%QUARTERDECK_AGENT_LAB_REAL_CODEX_HOME%"',
			'if "%~1"=="--version" goto passthrough',
			'if "%~1"=="-V" goto passthrough',
			'if "%~1"=="features" goto passthrough',
			'set "_QD_HAS_MODEL=0"',
			'set "_QD_HAS_SANDBOX=0"',
			'set "_QD_HAS_APPROVAL_POLICY=0"',
			"call :inspect_arguments %*",
			'set "_QD_MODEL_ARGUMENT=--model %QUARTERDECK_AGENT_LAB_REAL_CODEX_MODEL%"',
			'if "%_QD_HAS_MODEL%"=="1" set "_QD_MODEL_ARGUMENT="',
			'set "_QD_SANDBOX_ARGUMENT=--sandbox %QUARTERDECK_AGENT_LAB_REAL_CODEX_SANDBOX%"',
			'if "%_QD_HAS_SANDBOX%"=="1" set "_QD_SANDBOX_ARGUMENT="',
			'set "_QD_APPROVAL_ARGUMENT=--ask-for-approval %QUARTERDECK_AGENT_LAB_REAL_CODEX_APPROVAL_POLICY%"',
			'if "%_QD_HAS_APPROVAL_POLICY%"=="1" set "_QD_APPROVAL_ARGUMENT="',
			"(",
			'  set "QUARTERDECK_AGENT_LAB_REAL_CODEX_RUNTIME_PATH="',
			'  set "QUARTERDECK_AGENT_LAB_REAL_CODEX_HOST_PATH="',
			'  set "QUARTERDECK_AGENT_LAB_REAL_CODEX_HOME="',
			'  set "QUARTERDECK_AGENT_LAB_REAL_CODEX_MODEL="',
			'  set "QUARTERDECK_AGENT_LAB_REAL_CODEX_SANDBOX="',
			'  set "QUARTERDECK_AGENT_LAB_REAL_CODEX_APPROVAL_POLICY="',
			'  set "QUARTERDECK_AGENT_LAB_REAL_CODEX_BINARY="',
			'  set "_QD_HAS_MODEL="',
			'  set "_QD_HAS_SANDBOX="',
			'  set "_QD_HAS_APPROVAL_POLICY="',
			'  set "_QD_ARGUMENT="',
			'  set "_QD_MODEL_ARGUMENT="',
			'  set "_QD_SANDBOX_ARGUMENT="',
			'  set "_QD_APPROVAL_ARGUMENT="',
			`  call "%QUARTERDECK_AGENT_LAB_REAL_CODEX_BINARY%" ${windowsPolicyArguments} %_QD_MODEL_ARGUMENT% %_QD_SANDBOX_ARGUMENT% %_QD_APPROVAL_ARGUMENT% %*`,
			")",
			"exit /b %errorlevel%",
			":passthrough",
			"(",
			'  set "QUARTERDECK_AGENT_LAB_REAL_CODEX_RUNTIME_PATH="',
			'  set "QUARTERDECK_AGENT_LAB_REAL_CODEX_HOST_PATH="',
			'  set "QUARTERDECK_AGENT_LAB_REAL_CODEX_HOME="',
			'  set "QUARTERDECK_AGENT_LAB_REAL_CODEX_MODEL="',
			'  set "QUARTERDECK_AGENT_LAB_REAL_CODEX_SANDBOX="',
			'  set "QUARTERDECK_AGENT_LAB_REAL_CODEX_APPROVAL_POLICY="',
			'  set "QUARTERDECK_AGENT_LAB_REAL_CODEX_BINARY="',
			'  call "%QUARTERDECK_AGENT_LAB_REAL_CODEX_BINARY%" %*',
			")",
			"exit /b %errorlevel%",
			":inspect_arguments",
			'if "%~1"=="" exit /b 0',
			'if "%~1"=="--" exit /b 0',
			'set "_QD_ARGUMENT=%~1"',
			'if /I "%~1"=="-m" set "_QD_HAS_MODEL=1"',
			'if /I "%~1"=="--model" set "_QD_HAS_MODEL=1"',
			'if /I "%_QD_ARGUMENT:~0,8%"=="--model=" set "_QD_HAS_MODEL=1"',
			'if /I "%~1"=="-s" set "_QD_HAS_SANDBOX=1"',
			'if /I "%~1"=="--sandbox" set "_QD_HAS_SANDBOX=1"',
			'if /I "%_QD_ARGUMENT:~0,10%"=="--sandbox=" set "_QD_HAS_SANDBOX=1"',
			'if /I "%~1"=="-a" set "_QD_HAS_APPROVAL_POLICY=1"',
			'if /I "%~1"=="--ask-for-approval" set "_QD_HAS_APPROVAL_POLICY=1"',
			'if /I "%_QD_ARGUMENT:~0,19%"=="--ask-for-approval=" set "_QD_HAS_APPROVAL_POLICY=1"',
			'if /I "%~1"=="--approve-for-me" set "_QD_HAS_SANDBOX=1"',
			'if /I "%~1"=="--approve-for-me" set "_QD_HAS_APPROVAL_POLICY=1"',
			'if /I "%~1"=="--not-so-yolo" set "_QD_HAS_SANDBOX=1"',
			'if /I "%~1"=="--not-so-yolo" set "_QD_HAS_APPROVAL_POLICY=1"',
			'if /I "%~1"=="--dangerously-bypass-approvals-and-sandbox" set "_QD_HAS_SANDBOX=1"',
			'if /I "%~1"=="--dangerously-bypass-approvals-and-sandbox" set "_QD_HAS_APPROVAL_POLICY=1"',
			'if /I "%~1"=="--yolo" set "_QD_HAS_SANDBOX=1"',
			'if /I "%~1"=="--yolo" set "_QD_HAS_APPROVAL_POLICY=1"',
			"shift",
			"goto inspect_arguments",
			"",
		].join("\r\n"),
		"utf8",
	);
}

const REAL_CLAUDE_FORBIDDEN_ARGUMENTS = [
	"--add-dir",
	"--agent",
	"--agents",
	"--allow-dangerously-skip-permissions",
	"--allowedTools",
	"--allowed-tools",
	"--bg",
	"--background",
	"--chrome",
	"--cloud",
	"--dangerously-skip-permissions",
	"--ide",
	"--mcp-config",
	"--model",
	"-m",
	"--permission-mode",
	"--plugin-dir",
	"--plugin-url",
	"--remote-control",
	"--setting-sources",
	"--tmux",
	"--worktree",
	"-w",
] as const;

export async function writeRealClaudeLauncher(fakeBinPath: string): Promise<void> {
	const shellLauncherPath = join(fakeBinPath, "claude");
	const windowsLauncherPath = join(fakeBinPath, "claude.cmd");
	const shellForbiddenCases = REAL_CLAUDE_FORBIDDEN_ARGUMENTS.map((value) => `${value}|${value}=*`).join("|");
	const windowsForbiddenChecks = REAL_CLAUDE_FORBIDDEN_ARGUMENTS.flatMap((value) => [
		`if /I "%~1"=="${value}" set "_QD_CONFLICT=%~1"`,
		`if /I "%_QD_ARGUMENT:~0,${value.length + 1}%"=="${value}=" set "_QD_CONFLICT=%~1"`,
	]);
	const shellEnvironmentPolicy = Object.entries(AGENT_LAB_REAL_CLAUDE_ENVIRONMENT_POLICY).map(
		([key, value]) => `export ${key}='${value}'`,
	);
	const windowsEnvironmentPolicy = Object.entries(AGENT_LAB_REAL_CLAUDE_ENVIRONMENT_POLICY).map(
		([key, value]) => `set "${key}=${value}"`,
	);
	await writeFile(
		shellLauncherPath,
		[
			"#!/bin/sh",
			"set -eu",
			'real_claude_runtime_path="$PATH"',
			'real_claude_host_path="$QUARTERDECK_AGENT_LAB_REAL_CLAUDE_HOST_PATH"',
			'real_claude_config_dir="$QUARTERDECK_AGENT_LAB_REAL_CLAUDE_CONFIG_DIR"',
			'real_claude_mcp_config="$QUARTERDECK_AGENT_LAB_REAL_CLAUDE_MCP_CONFIG"',
			'real_claude_model="$QUARTERDECK_AGENT_LAB_REAL_CLAUDE_MODEL"',
			'real_claude_permission_mode="$QUARTERDECK_AGENT_LAB_REAL_CLAUDE_PERMISSION_MODE"',
			`real_claude_environment_auth="\${QUARTERDECK_AGENT_LAB_REAL_CLAUDE_ENVIRONMENT_AUTH:-0}"`,
			'real_claude_binary=$(PATH="$real_claude_host_path" command -v claude 2>/dev/null || true)',
			'if [ -z "$real_claude_binary" ]; then echo "Agent Lab could not resolve the host Claude binary." >&2; exit 127; fi',
			'export PATH="$real_claude_runtime_path"',
			'export CLAUDE_CONFIG_DIR="$real_claude_config_dir"',
			...shellEnvironmentPolicy,
			'if [ "$real_claude_environment_auth" != "1" ]; then unset ANTHROPIC_API_KEY ANTHROPIC_AUTH_TOKEN CLAUDE_CODE_OAUTH_TOKEN; fi',
			"unset QUARTERDECK_AGENT_LAB_REAL_CLAUDE_HOST_PATH",
			"unset QUARTERDECK_AGENT_LAB_REAL_CLAUDE_CONFIG_DIR",
			"unset QUARTERDECK_AGENT_LAB_REAL_CLAUDE_MCP_CONFIG",
			"unset QUARTERDECK_AGENT_LAB_REAL_CLAUDE_MODEL",
			"unset QUARTERDECK_AGENT_LAB_REAL_CLAUDE_PERMISSION_MODE",
			"unset QUARTERDECK_AGENT_LAB_REAL_CLAUDE_ENVIRONMENT_AUTH",
			`case "\${1-}" in`,
			"  --version|-v)",
			'    exec "$real_claude_binary" "$@"',
			"    ;;",
			"esac",
			"settings_count=0",
			'for argument in "$@"; do',
			'  if [ "$argument" = "--" ]; then break; fi',
			'  case "$argument" in',
			"    --settings|--settings=*) settings_count=$((settings_count + 1)) ;;",
			`    ${shellForbiddenCases}) echo "Agent Lab real Claude rejects conflicting launch argument: $argument" >&2; exit 64 ;;`,
			"  esac",
			"done",
			'if [ "$settings_count" -ne 1 ]; then echo "Agent Lab real Claude requires exactly one Quarterdeck launch-scoped --settings file." >&2; exit 64; fi',
			'exec "$real_claude_binary" --model "$real_claude_model" --permission-mode "$real_claude_permission_mode" --setting-sources "" --strict-mcp-config --mcp-config "$real_claude_mcp_config" --no-chrome --disable-slash-commands "$@"',
			"",
		].join("\n"),
		"utf8",
	);
	await chmod(shellLauncherPath, 0o755);
	await writeFile(
		windowsLauncherPath,
		[
			"@echo off",
			"setlocal",
			'set "QUARTERDECK_AGENT_LAB_REAL_CLAUDE_RUNTIME_PATH=%PATH%"',
			'set "PATH=%QUARTERDECK_AGENT_LAB_REAL_CLAUDE_HOST_PATH%"',
			'set "QUARTERDECK_AGENT_LAB_REAL_CLAUDE_BINARY="',
			'for /f "delims=" %%I in (\'where claude 2^>nul\') do if not defined QUARTERDECK_AGENT_LAB_REAL_CLAUDE_BINARY set "QUARTERDECK_AGENT_LAB_REAL_CLAUDE_BINARY=%%I"',
			"if not defined QUARTERDECK_AGENT_LAB_REAL_CLAUDE_BINARY (",
			"  echo Agent Lab could not resolve the host Claude binary. 1>&2",
			"  exit /b 127",
			")",
			'set "PATH=%QUARTERDECK_AGENT_LAB_REAL_CLAUDE_RUNTIME_PATH%"',
			'set "CLAUDE_CONFIG_DIR=%QUARTERDECK_AGENT_LAB_REAL_CLAUDE_CONFIG_DIR%"',
			...windowsEnvironmentPolicy,
			'if not "%QUARTERDECK_AGENT_LAB_REAL_CLAUDE_ENVIRONMENT_AUTH%"=="1" set "ANTHROPIC_API_KEY="',
			'if not "%QUARTERDECK_AGENT_LAB_REAL_CLAUDE_ENVIRONMENT_AUTH%"=="1" set "ANTHROPIC_AUTH_TOKEN="',
			'if not "%QUARTERDECK_AGENT_LAB_REAL_CLAUDE_ENVIRONMENT_AUTH%"=="1" set "CLAUDE_CODE_OAUTH_TOKEN="',
			'if "%~1"=="--version" goto passthrough',
			'if "%~1"=="-v" goto passthrough',
			'set "_QD_SETTINGS_COUNT=0"',
			'set "_QD_CONFLICT="',
			"call :inspect_arguments %*",
			"if defined _QD_CONFLICT (",
			"  echo Agent Lab real Claude rejects conflicting launch argument: %_QD_CONFLICT% 1>&2",
			"  exit /b 64",
			")",
			'if not "%_QD_SETTINGS_COUNT%"=="1" (',
			"  echo Agent Lab real Claude requires exactly one Quarterdeck launch-scoped --settings file. 1>&2",
			"  exit /b 64",
			")",
			"(",
			'  set "QUARTERDECK_AGENT_LAB_REAL_CLAUDE_RUNTIME_PATH="',
			'  set "QUARTERDECK_AGENT_LAB_REAL_CLAUDE_HOST_PATH="',
			'  set "QUARTERDECK_AGENT_LAB_REAL_CLAUDE_CONFIG_DIR="',
			'  set "QUARTERDECK_AGENT_LAB_REAL_CLAUDE_MCP_CONFIG="',
			'  set "QUARTERDECK_AGENT_LAB_REAL_CLAUDE_MODEL="',
			'  set "QUARTERDECK_AGENT_LAB_REAL_CLAUDE_PERMISSION_MODE="',
			'  set "QUARTERDECK_AGENT_LAB_REAL_CLAUDE_ENVIRONMENT_AUTH="',
			'  set "_QD_SETTINGS_COUNT="',
			'  set "_QD_CONFLICT="',
			'  set "_QD_ARGUMENT="',
			'  call "%QUARTERDECK_AGENT_LAB_REAL_CLAUDE_BINARY%" --model "%QUARTERDECK_AGENT_LAB_REAL_CLAUDE_MODEL%" --permission-mode "%QUARTERDECK_AGENT_LAB_REAL_CLAUDE_PERMISSION_MODE%" --setting-sources "" --strict-mcp-config --mcp-config "%QUARTERDECK_AGENT_LAB_REAL_CLAUDE_MCP_CONFIG%" --no-chrome --disable-slash-commands %*',
			")",
			"exit /b %errorlevel%",
			":passthrough",
			"(",
			'  set "QUARTERDECK_AGENT_LAB_REAL_CLAUDE_RUNTIME_PATH="',
			'  set "QUARTERDECK_AGENT_LAB_REAL_CLAUDE_HOST_PATH="',
			'  set "QUARTERDECK_AGENT_LAB_REAL_CLAUDE_CONFIG_DIR="',
			'  set "QUARTERDECK_AGENT_LAB_REAL_CLAUDE_MCP_CONFIG="',
			'  set "QUARTERDECK_AGENT_LAB_REAL_CLAUDE_MODEL="',
			'  set "QUARTERDECK_AGENT_LAB_REAL_CLAUDE_PERMISSION_MODE="',
			'  set "QUARTERDECK_AGENT_LAB_REAL_CLAUDE_ENVIRONMENT_AUTH="',
			'  call "%QUARTERDECK_AGENT_LAB_REAL_CLAUDE_BINARY%" %*',
			")",
			"exit /b %errorlevel%",
			":inspect_arguments",
			'if "%~1"=="" exit /b 0',
			'if "%~1"=="--" exit /b 0',
			'set "_QD_ARGUMENT=%~1"',
			'if /I "%~1"=="--settings" set /a _QD_SETTINGS_COUNT+=1',
			'if /I "%_QD_ARGUMENT:~0,11%"=="--settings=" set /a _QD_SETTINGS_COUNT+=1',
			...windowsForbiddenChecks,
			"shift",
			"goto inspect_arguments",
			"",
		].join("\r\n"),
		"utf8",
	);
}

export async function writeAgentProviderLaunchers(
	fakeBinPath: string,
	agent: AgentLabLaunchConfig["agent"],
): Promise<void> {
	const providerPolicy = resolveAgentLabProviderPolicy(agent);
	const blockedLauncherWrites = providerPolicy.blockedAgentIds.map((provider) =>
		writeBlockedAgentLaunchers(fakeBinPath, provider),
	);
	let enabledLauncherWrites: Promise<void>[];
	switch (agent.mode) {
		case "fake":
			enabledLauncherWrites = [
				writeFakeAgentLaunchers(fakeBinPath, "codex"),
				writeFakeAgentLaunchers(fakeBinPath, "pi"),
			];
			break;
		case "fake-claude":
			enabledLauncherWrites = [writeFakeAgentLaunchers(fakeBinPath, "claude")];
			break;
		case "real-codex":
			enabledLauncherWrites = [writeRealCodexLauncher(fakeBinPath)];
			break;
		case "real-claude":
			enabledLauncherWrites = [writeRealClaudeLauncher(fakeBinPath)];
			break;
		default: {
			const unsupportedAgent: never = agent;
			throw new Error(`Unsupported Agent Lab provider mode: ${String(unsupportedAgent)}`);
		}
	}

	await Promise.all([...enabledLauncherWrites, ...blockedLauncherWrites]);
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
	const hostEventLedgerPath = join(config.artifactDir, "host-events.json");
	const hostSimulationConfigPath = join(config.artifactDir, "host-simulation-config.json");
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
		writeFile(
			hostSimulationConfigPath,
			`${JSON.stringify(
				{
					schemaVersion: 1,
					ledgerPath: hostEventLedgerPath,
					pathScopes: [
						{ id: "primary_project", rootPath: projectPath },
						{ id: "secondary_project", rootPath: additionalProjectPath },
						{ id: "runtime_state", rootPath: statePath },
						{ id: "runtime_home", rootPath: homePath },
					],
				} satisfies RuntimeHostSimulationConfig,
				null,
				2,
			)}\n`,
			"utf8",
		),
	]);

	await Promise.all([
		writeFile(
			join(statePath, "config.json"),
			`${JSON.stringify(
				{
					selectedAgentId:
						config.agent.mode === "fake-claude" || config.agent.mode === "real-claude" ? "claude" : "codex",
					logLevel: "debug",
					...(config.agent.mode === "real-codex" ? { codexApprovalsReviewer: "user" } : {}),
				},
				null,
				2,
			)}\n`,
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
	await Promise.all([
		writeAgentProviderLaunchers(fakeBinPath, config.agent),
		writeForbiddenHostLaunchers(fakeBinPath),
	]);
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
		hostEventLedgerPath,
		hostSimulationConfigPath,
	};
}
