import { spawn } from "node:child_process";
import { constants } from "node:fs";
import { access, rm, symlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve, win32 } from "node:path";

import { resolveWindowsCompatibleCommand, terminateProcessForTimeout } from "../../src/core";
import { getWindowsEnvironmentValue } from "../../src/core/windows-system-paths.js";
import { copyPrivateDiagnosticFile, ensurePrivateDiagnosticDirectory } from "../../src/diagnostics";
import {
	type AgentLabCodexApprovalPolicy,
	type AgentLabCodexSandbox,
	type AgentLabLaunchAgentConfig,
	AgentLabLaunchAgentConfigSchema,
} from "./types";

export const DEFAULT_AGENT_LAB_REAL_CODEX_MODEL = "gpt-5.6-luna";
export const DEFAULT_AGENT_LAB_REAL_CODEX_SANDBOX: AgentLabCodexSandbox = "read-only";
export const DEFAULT_AGENT_LAB_REAL_CODEX_APPROVAL_POLICY: AgentLabCodexApprovalPolicy = "on-request";

/**
 * Highest-precedence profile policy for authenticated lab tasks. These values
 * preserve cached OpenAI authentication while removing profile-defined host
 * crossings, extra model work, and content exporters from the synthetic run.
 * Quarterdeck's launch-scoped hook overrides are appended later and therefore
 * repopulate only the hooks owned by the runtime.
 */
export const AGENT_LAB_REAL_CODEX_CONFIG_OVERRIDES = [
	"service_tier='default'",
	"model_provider='openai'",
	"model_reasoning_effort='low'",
	"history.persistence='none'",
	"web_search='disabled'",
	"analytics.enabled=false",
	"check_for_update_on_startup=false",
	"agents.enabled=false",
	"memories.generate_memories=false",
	"memories.use_memories=false",
	"features.fast_mode=false",
	"features.goals=false",
	"features.memories=false",
	"features.multi_agent=false",
	"features.apps=false",
	"features.browser_use=false",
	"features.browser_use_external=false",
	"features.network_proxy=false",
	"features.remote_plugin=false",
	"features.skill_mcp_dependency_install=false",
	"features.workspace_dependencies=false",
	"notify=[]",
	"feedback.enabled=false",
	"file_opener='none'",
	"otel.exporter='none'",
	"otel.metrics_exporter='none'",
	"otel.trace_exporter='none'",
	"otel.log_user_prompt=false",
	"allow_login_shell=false",
	"shell_environment_policy.experimental_use_profile=false",
	"shell_environment_policy.ignore_default_excludes=false",
	"shell_environment_policy.filters={CODEX_HOME='exclude',QUARTERDECK_AGENT_LAB_REAL_CODEX_HOME='exclude',QUARTERDECK_AGENT_LAB_REAL_CODEX_HOST_PATH='exclude'}",
] as const;

const LOGIN_STATUS_TIMEOUT_MS = 10_000;
const PREFLIGHT_ENVIRONMENT_KEYS = [
	"PATH",
	"PATHEXT",
	"SystemRoot",
	"WINDIR",
	"ComSpec",
	"HOME",
	"USERPROFILE",
	"APPDATA",
	"LOCALAPPDATA",
	"LANG",
	"LC_ALL",
	"LC_CTYPE",
	"TMPDIR",
	"TEMP",
	"TMP",
	"CODEX_CA_CERTIFICATE",
	"SSL_CERT_FILE",
] as const;

export interface ResolveRealCodexAgentOptions {
	model?: string;
	codexHomePath?: string;
	sandbox?: AgentLabCodexSandbox;
	approvalPolicy?: AgentLabCodexApprovalPolicy;
	platform?: NodeJS.Platform;
}

export function resolveRealCodexAgent(
	options: ResolveRealCodexAgentOptions = {},
	source: NodeJS.ProcessEnv = process.env,
): Extract<AgentLabLaunchAgentConfig, { mode: "real-codex" }> {
	const explicitCodexHome = options.codexHomePath?.trim();
	const platform = options.platform ?? process.platform;
	const environmentCodexHome = (
		platform === "win32" ? getWindowsEnvironmentValue(source, "CODEX_HOME") : source.CODEX_HOME
	)?.trim();
	const profileSource = explicitCodexHome ? "explicit" : environmentCodexHome ? "environment" : "default";
	const profilePath = explicitCodexHome || environmentCodexHome || join(homedir(), ".codex");
	const codexHomePath = platform === "win32" ? win32.resolve(profilePath) : resolve(profilePath);

	const parsed = AgentLabLaunchAgentConfigSchema.parse({
		mode: "real-codex",
		model: options.model?.trim() || DEFAULT_AGENT_LAB_REAL_CODEX_MODEL,
		modelProvider: "openai",
		reasoningEffort: "low",
		authentication: "existing-cli",
		profileSource,
		sandbox: options.sandbox ?? DEFAULT_AGENT_LAB_REAL_CODEX_SANDBOX,
		approvalPolicy: options.approvalPolicy ?? DEFAULT_AGENT_LAB_REAL_CODEX_APPROVAL_POLICY,
		serviceTier: "default",
		historyPersistence: "none",
		webSearch: "disabled",
		externalIntegrations: "disabled",
		profileHooks: "isolated",
		telemetry: "disabled",
		codexHomePath,
	});
	if (parsed.mode !== "real-codex") {
		throw new Error("Agent Lab resolved an unexpected fake-agent configuration.");
	}
	return parsed;
}

export function buildRealCodexPreflightEnvironment(
	source: NodeJS.ProcessEnv,
	agent: Extract<AgentLabLaunchAgentConfig, { mode: "real-codex" }>,
	platform: NodeJS.Platform = process.platform,
): NodeJS.ProcessEnv {
	const environment: NodeJS.ProcessEnv = {};
	for (const key of PREFLIGHT_ENVIRONMENT_KEYS) {
		const value = platform === "win32" ? getWindowsEnvironmentValue(source, key) : source[key];
		if (value) environment[key] = value;
	}
	return {
		...environment,
		CODEX_HOME: agent.codexHomePath,
	};
}

export async function assertReusableRealCodexAuthentication(
	agent: Extract<AgentLabLaunchAgentConfig, { mode: "real-codex" }>,
	source: NodeJS.ProcessEnv = process.env,
): Promise<void> {
	const environment = buildRealCodexPreflightEnvironment(source, agent);
	const command = resolveWindowsCompatibleCommand("codex", ["login", "status"], process.platform, environment);
	const exitCode = await new Promise<number>((resolveExit, rejectExit) => {
		const child = spawn(command.binary, command.args, {
			env: environment,
			stdio: "ignore",
			windowsHide: true,
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
			finish(() => rejectExit(new Error("Timed out checking the existing Codex CLI login.")));
		}, LOGIN_STATUS_TIMEOUT_MS);
		timeout.unref();
		child.once("error", () =>
			finish(() => rejectExit(new Error("Could not run `codex login status` from the current PATH."))),
		);
		child.once("exit", (code, signal) => finish(() => resolveExit(signal === null ? (code ?? 1) : 1)));
	});
	if (exitCode !== 0) {
		throw new Error(
			"The selected Codex profile is not logged in. Run `codex login` for that profile, then retry Agent Lab.",
		);
	}
}

interface PrepareIsolatedRealCodexAgentOptions {
	platform?: NodeJS.Platform;
	validateAuthentication?: typeof assertReusableRealCodexAuthentication;
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
 * Builds a credential-only Codex home inside the disposable lab root. Profile
 * configuration is intentionally not copied or linked: the authenticated
 * provider starts from defaults plus the launch-scoped policy above.
 */
export async function prepareIsolatedRealCodexAgent(
	agent: Extract<AgentLabLaunchAgentConfig, { mode: "real-codex" }>,
	tempRoot: string,
	source: NodeJS.ProcessEnv = process.env,
	options: PrepareIsolatedRealCodexAgentOptions = {},
): Promise<Extract<AgentLabLaunchAgentConfig, { mode: "real-codex" }>> {
	const isolatedCodexHomePath = join(tempRoot, "codex-home");
	const sourceAuthPath = join(agent.codexHomePath, "auth.json");
	const isolatedAuthPath = join(isolatedCodexHomePath, "auth.json");
	const isolatedConfigPath = join(isolatedCodexHomePath, "config.toml");
	const platform = options.platform ?? process.platform;
	const validateAuthentication = options.validateAuthentication ?? assertReusableRealCodexAuthentication;

	await ensurePrivateDiagnosticDirectory(isolatedCodexHomePath);
	const hasFileCredential = await pathIsReadable(sourceAuthPath);
	if (hasFileCredential) {
		if (platform === "win32") {
			await copyPrivateDiagnosticFile(sourceAuthPath, isolatedAuthPath);
		} else {
			await symlink(sourceAuthPath, isolatedAuthPath);
		}
	} else {
		await writeFile(isolatedConfigPath, 'cli_auth_credentials_store = "keyring"\n', {
			encoding: "utf8",
			mode: 0o600,
		});
	}

	const isolatedAgent = AgentLabLaunchAgentConfigSchema.parse({
		...agent,
		codexHomePath: isolatedCodexHomePath,
	});
	if (isolatedAgent.mode !== "real-codex") {
		throw new Error("Agent Lab prepared an unexpected fake-agent configuration.");
	}
	try {
		await validateAuthentication(isolatedAgent, source);
	} catch {
		await rm(isolatedAuthPath, { force: true });
		throw new Error(
			hasFileCredential
				? "The existing Codex CLI credential could not be reused from Agent Lab's isolated profile."
				: "The existing Codex CLI login uses a credential store that Agent Lab could not reuse from an isolated profile.",
		);
	}
	return isolatedAgent;
}
