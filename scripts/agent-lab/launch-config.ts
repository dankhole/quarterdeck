import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { ensurePrivateDiagnosticDirectories } from "../../src/diagnostics";
import { createAgentLabRunId, getAgentLabArtifactRoot, resolveRunArtifactDir, writeJsonAtomic } from "./paths";
import {
	AGENT_LAB_SCHEMA_VERSION,
	type AgentLabLaunchAgentConfig,
	type AgentLabLaunchConfig,
	type AgentLabScenario,
} from "./types";

export interface CreateAgentLabLaunchConfigOptions {
	name?: string;
	runId?: string;
	repoRoot?: string;
	artifactRoot?: string;
	scenario?: AgentLabScenario;
	agent?: AgentLabLaunchAgentConfig;
	keepTemp?: boolean;
	runtimePort?: number | null;
	webPort?: number | null;
	forwardLogs?: boolean;
}

export async function createAgentLabLaunchConfig(
	options: CreateAgentLabLaunchConfigOptions = {},
): Promise<AgentLabLaunchConfig> {
	const repoRoot = resolve(options.repoRoot ?? process.cwd());
	const runId = options.runId ?? createAgentLabRunId(options.name);
	const artifactRoot = resolve(options.artifactRoot ?? getAgentLabArtifactRoot(repoRoot));
	const artifactDir = resolveRunArtifactDir(runId, artifactRoot);
	const tempRoot = await mkdtemp(join(tmpdir(), "quarterdeck-agent-lab-"));
	await ensurePrivateDiagnosticDirectories([artifactRoot, artifactDir, tempRoot]);

	return {
		schemaVersion: AGENT_LAB_SCHEMA_VERSION,
		runId,
		repoRoot,
		artifactDir,
		manifestPath: join(artifactDir, "manifest.json"),
		stopRequestPath: join(artifactDir, "stop-request.json"),
		runtimeRestartRequestPath: join(artifactDir, "runtime-restart-request.json"),
		runtimeRestartResultPath: join(artifactDir, "runtime-restart-result.json"),
		tempRoot,
		keepTemp: options.keepTemp ?? false,
		scenario: options.scenario ?? "idle",
		agent: options.agent ?? { mode: "fake" },
		runtimePort: options.runtimePort ?? null,
		webPort: options.webPort ?? null,
		forwardLogs: options.forwardLogs ?? false,
		runtimeCapabilities: { nativeUiAvailable: false, hostIntegrationMode: "simulated" },
	};
}

export async function persistAgentLabLaunchConfig(config: AgentLabLaunchConfig): Promise<string> {
	const configPath = join(config.tempRoot, "supervisor-config.json");
	await writeJsonAtomic(configPath, config);
	return configPath;
}
