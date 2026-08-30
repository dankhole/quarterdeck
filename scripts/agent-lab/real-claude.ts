import { spawn } from "node:child_process";
import { constants } from "node:fs";
import { access, chmod, copyFile, mkdir, symlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

import { resolveWindowsCompatibleCommand, terminateProcessForTimeout } from "../../src/core";
import { type AgentLabLaunchAgentConfig, AgentLabLaunchAgentConfigSchema } from "./types";

export const DEFAULT_AGENT_LAB_REAL_CLAUDE_MODEL = "haiku";
export const DEFAULT_AGENT_LAB_REAL_CLAUDE_PERMISSION_MODE = "manual" as const;

const AUTH_STATUS_TIMEOUT_MS = 10_000;
const PREFLIGHT_ENVIRONMENT_KEYS = [
	"PATH",
	"Path",
	"PATHEXT",
	"SystemRoot",
	"ComSpec",
	"HOME",
	"USERPROFILE",
	"LANG",
	"LC_ALL",
	"LC_CTYPE",
	"TMPDIR",
	"TEMP",
	"TMP",
	"SSL_CERT_FILE",
	"NODE_EXTRA_CA_CERTS",
] as const;

export const AGENT_LAB_REAL_CLAUDE_GATEWAY_ENVIRONMENT_KEYS = [
	"ANTHROPIC_API_KEY",
	"ANTHROPIC_AUTH_TOKEN",
	"ANTHROPIC_BASE_URL",
	"ANTHROPIC_BEDROCK_BASE_URL",
	"ANTHROPIC_DEFAULT_HAIKU_MODEL",
	"ANTHROPIC_SMALL_FAST_MODEL",
	"ANTHROPIC_SMALL_FAST_MODEL_AWS_REGION",
	"CLAUDE_CODE_OAUTH_TOKEN",
	"CLAUDE_CODE_SKIP_BEDROCK_AUTH",
	"CLAUDE_CODE_USE_BEDROCK",
	"AWS_ACCESS_KEY_ID",
	"AWS_SECRET_ACCESS_KEY",
	"AWS_SESSION_TOKEN",
	"AWS_BEARER_TOKEN_BEDROCK",
	"AWS_DEFAULT_REGION",
	"AWS_REGION",
] as const;

export const AGENT_LAB_REAL_CLAUDE_ENVIRONMENT_POLICY = {
	DISABLE_AUTOUPDATER: "1",
	DISABLE_TELEMETRY: "1",
	DISABLE_ERROR_REPORTING: "1",
	DISABLE_FEEDBACK_COMMAND: "1",
	CLAUDE_CODE_DISABLE_FEEDBACK_SURVEY: "1",
	CLAUDE_CODE_DISABLE_AGENT_VIEW: "1",
	CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
	CLAUDE_CODE_DISABLE_TERMINAL_TITLE: "1",
} as const;

export interface ResolveRealClaudeAgentOptions {
	model?: string;
	claudeConfigDirPath?: string;
	environmentAuthentication?: boolean;
}

export function resolveRealClaudeAgent(
	options: ResolveRealClaudeAgentOptions = {},
	source: NodeJS.ProcessEnv = process.env,
): Extract<AgentLabLaunchAgentConfig, { mode: "real-claude" }> {
	const explicitConfigDir = options.claudeConfigDirPath?.trim();
	const environmentConfigDir = source.CLAUDE_CONFIG_DIR?.trim();
	const profileSource = explicitConfigDir ? "explicit" : environmentConfigDir ? "environment" : "default";
	const claudeConfigDirPath = resolve(explicitConfigDir || environmentConfigDir || join(homedir(), ".claude"));
	const environmentAuthentication = options.environmentAuthentication === true;

	const parsed = AgentLabLaunchAgentConfigSchema.parse({
		mode: "real-claude",
		model: options.model?.trim() || DEFAULT_AGENT_LAB_REAL_CLAUDE_MODEL,
		modelProvider: "anthropic",
		authentication: environmentAuthentication ? "environment" : "existing-cli",
		profileSource,
		credentialBoundary: environmentAuthentication ? "provider-environment-forwarded" : "host-store-reused",
		permissionMode: DEFAULT_AGENT_LAB_REAL_CLAUDE_PERMISSION_MODE,
		settingsSources: "none",
		managedSettings: "inherited",
		historyPersistence: "disposable",
		externalIntegrations: "unmanaged-disabled",
		profileHooks: "isolated",
		telemetry: "disabled",
		budgetLimit: "model-and-prompt-only",
		claudeConfigDirPath,
		mcpConfigPath: null,
	});
	if (parsed.mode !== "real-claude") {
		throw new Error("Agent Lab resolved an unexpected non-Claude configuration.");
	}
	return parsed;
}

export function buildRealClaudePreflightEnvironment(
	source: NodeJS.ProcessEnv,
	agent: Extract<AgentLabLaunchAgentConfig, { mode: "real-claude" }>,
): NodeJS.ProcessEnv {
	const environment: NodeJS.ProcessEnv = {};
	for (const key of PREFLIGHT_ENVIRONMENT_KEYS) {
		const value = source[key];
		if (value) environment[key] = value;
	}
	if (agent.authentication === "environment") {
		for (const key of AGENT_LAB_REAL_CLAUDE_GATEWAY_ENVIRONMENT_KEYS) {
			const value = source[key];
			if (value) environment[key] = value;
		}
	}
	return {
		...environment,
		...AGENT_LAB_REAL_CLAUDE_ENVIRONMENT_POLICY,
		CLAUDE_CONFIG_DIR: agent.claudeConfigDirPath,
	};
}

export async function assertReusableRealClaudeAuthentication(
	agent: Extract<AgentLabLaunchAgentConfig, { mode: "real-claude" }>,
	source: NodeJS.ProcessEnv = process.env,
): Promise<void> {
	const environment = buildRealClaudePreflightEnvironment(source, agent);
	const command = resolveWindowsCompatibleCommand(
		"claude",
		["auth", "status", "--json"],
		process.platform,
		environment,
	);
	const exitCode = await new Promise<number>((resolveExit, rejectExit) => {
		const child = spawn(command.binary, command.args, {
			env: environment,
			stdio: "ignore",
		});
		let settled = false;
		const finish = (action: () => void): void => {
			if (settled) return;
			settled = true;
			clearTimeout(timeout);
			action();
		};
		const timeout = setTimeout(() => {
			try {
				terminateProcessForTimeout(child);
			} catch {
				// The process may have exited at the deadline.
			}
			finish(() => rejectExit(new Error("Timed out checking the existing Claude CLI login.")));
		}, AUTH_STATUS_TIMEOUT_MS);
		timeout.unref();
		child.once("error", () =>
			finish(() => rejectExit(new Error("Could not run `claude auth status --json` from the current PATH."))),
		);
		child.once("exit", (code, signal) => finish(() => resolveExit(signal === null ? (code ?? 1) : 1)));
	});
	if (exitCode !== 0) {
		throw new Error(
			agent.authentication === "environment"
				? "Claude rejected the explicitly selected gateway/environment authentication. Check the exported provider variables and retry Agent Lab."
				: "The selected Claude profile is not logged in. Run `claude auth login` for that profile, then retry Agent Lab.",
		);
	}
}

interface PrepareIsolatedRealClaudeAgentOptions {
	platform?: NodeJS.Platform;
	validateAuthentication?: typeof assertReusableRealClaudeAuthentication;
}

async function pathIsReadable(path: string): Promise<boolean> {
	try {
		await access(path, constants.R_OK);
		return true;
	} catch (error) {
		if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") {
			return false;
		}
		throw error;
	}
}

/**
 * Builds a disposable Claude config/session root while reusing only the host
 * credential. macOS keeps OAuth credentials in Keychain, so its boundary is
 * process configuration rather than a copied HOME. Linux and Windows stage
 * only Claude's documented credential file.
 */
export async function prepareIsolatedRealClaudeAgent(
	agent: Extract<AgentLabLaunchAgentConfig, { mode: "real-claude" }>,
	tempRoot: string,
	source: NodeJS.ProcessEnv = process.env,
	options: PrepareIsolatedRealClaudeAgentOptions = {},
): Promise<Extract<AgentLabLaunchAgentConfig, { mode: "real-claude" }>> {
	const isolatedConfigDirPath = join(tempRoot, "claude-config");
	const sourceCredentialPath = join(agent.claudeConfigDirPath, ".credentials.json");
	const isolatedCredentialPath = join(isolatedConfigDirPath, ".credentials.json");
	const mcpConfigPath = join(isolatedConfigDirPath, "agent-lab-empty-mcp.json");
	const platform = options.platform ?? process.platform;
	const validateAuthentication = options.validateAuthentication ?? assertReusableRealClaudeAuthentication;

	await mkdir(isolatedConfigDirPath, { recursive: true, mode: 0o700 });
	await writeFile(join(isolatedConfigDirPath, ".claude.json"), '{"hasCompletedOnboarding":true}\n', {
		encoding: "utf8",
		mode: 0o600,
	});
	await writeFile(mcpConfigPath, '{"mcpServers":{}}\n', { encoding: "utf8", mode: 0o600 });
	const hasFileCredential = agent.authentication === "existing-cli" && (await pathIsReadable(sourceCredentialPath));
	if (hasFileCredential) {
		if (platform === "win32") {
			await copyFile(sourceCredentialPath, isolatedCredentialPath);
			await chmod(isolatedCredentialPath, 0o600);
		} else {
			await symlink(sourceCredentialPath, isolatedCredentialPath);
		}
	}

	const isolatedAgent = AgentLabLaunchAgentConfigSchema.parse({
		...agent,
		claudeConfigDirPath: isolatedConfigDirPath,
		mcpConfigPath,
	});
	if (isolatedAgent.mode !== "real-claude") {
		throw new Error("Agent Lab prepared an unexpected non-Claude configuration.");
	}
	try {
		await validateAuthentication(isolatedAgent, source);
	} catch {
		throw new Error(
			agent.authentication === "environment"
				? "Claude gateway/environment authentication could not be reused from Agent Lab's isolated config directory."
				: platform === "darwin"
					? "The existing Claude CLI Keychain credential could not be reused from Agent Lab's isolated config directory."
					: hasFileCredential
						? "The existing Claude CLI credential could not be reused from Agent Lab's isolated config directory."
						: "Agent Lab found no reusable Claude CLI credential file in the selected config directory.",
		);
	}
	return isolatedAgent;
}
