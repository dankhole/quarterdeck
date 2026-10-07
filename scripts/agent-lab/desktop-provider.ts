import { execFile } from "node:child_process";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";

import { resolveWindowsCompatibleCommand } from "../../src/core";
import type { DesktopAgentMode } from "./desktop-types";
import {
	buildRealClaudePreflightEnvironment,
	prepareIsolatedRealClaudeAgent,
	resolveRealClaudeAgent,
} from "./real-claude";
import { buildRealCodexPreflightEnvironment, prepareIsolatedRealCodexAgent, resolveRealCodexAgent } from "./real-codex";
import type { AgentLabLaunchAgentConfig } from "./types";

const execFileAsync = promisify(execFile);

export function parseDesktopProviderVersion(agentId: "codex" | "claude", output: string): string | null {
	const pattern =
		agentId === "codex"
			? /^codex-cli (\d+\.\d+\.\d+(?:[-+][A-Za-z0-9.-]+)?)\s*$/u
			: /^(\d+\.\d+\.\d+(?:[-+][A-Za-z0-9.-]+)?) \(Claude Code\)\s*$/u;
	return output.trim().match(pattern)?.[1] ?? null;
}

export async function readDesktopProviderVersion(
	agent: AgentLabLaunchAgentConfig,
	source: NodeJS.ProcessEnv,
): Promise<string | null> {
	if (agent.mode !== "real-codex" && agent.mode !== "real-claude") return null;
	const agentId = agent.mode === "real-codex" ? "codex" : "claude";
	const environment =
		agent.mode === "real-codex"
			? buildRealCodexPreflightEnvironment(source, agent)
			: buildRealClaudePreflightEnvironment(source, agent);
	const command = resolveWindowsCompatibleCommand(agentId, ["--version"], process.platform, environment);
	try {
		const result = await execFileAsync(command.binary, command.args, {
			env: environment,
			encoding: "utf8",
			timeout: 10_000,
			maxBuffer: 16_384,
			windowsHide: true,
		});
		const version = parseDesktopProviderVersion(agentId, result.stdout);
		if (version) return version;
	} catch {
		// Never propagate provider output or credential/profile details into artifacts.
	}
	throw new Error(`Could not obtain a recognized ${agentId} version within the desktop preflight bound.`);
}

export function resolveDesktopProvider(mode: DesktopAgentMode, source: NodeJS.ProcessEnv): AgentLabLaunchAgentConfig {
	if (mode === "real-codex") return resolveRealCodexAgent({}, source);
	if (mode === "real-claude") return resolveRealClaudeAgent({}, source);
	return { mode: "fake" };
}

export async function isolateDesktopProvider(
	agent: AgentLabLaunchAgentConfig,
	tempRoot: string,
	source: NodeJS.ProcessEnv,
): Promise<AgentLabLaunchAgentConfig> {
	if (agent.mode === "real-codex") return await prepareIsolatedRealCodexAgent(agent, tempRoot, source);
	if (agent.mode === "real-claude") return await prepareIsolatedRealClaudeAgent(agent, tempRoot, source);
	return agent;
}

/** Remove disposable credential/profile roots even when keepTemp retains synthetic state. */
export async function removeDesktopProviderProfiles(tempRoot: string): Promise<void> {
	await Promise.all(
		["codex-home", "claude-config"].map((directory) =>
			rm(join(tempRoot, directory), { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }),
		),
	);
}

export function validateDesktopProviderSelection(mode: DesktopAgentMode, includeAgent: boolean): void {
	if (mode !== "fake" && !includeAgent)
		throw new Error("--no-agent cannot be combined with a real provider; no authentication was accessed.");
}
