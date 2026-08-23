import { mkdir, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { createAgentLabRunId, getAgentLabArtifactRoot, resolveRunArtifactDir, writeJsonAtomic } from "./paths";
import { AGENT_LAB_SCHEMA_VERSION, type AgentLabLaunchConfig, type AgentLabScenario } from "./types";

export interface CreateAgentLabLaunchConfigOptions {
	name?: string;
	runId?: string;
	repoRoot?: string;
	artifactRoot?: string;
	scenario?: AgentLabScenario;
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
	await mkdir(artifactDir, { recursive: true });

	return {
		schemaVersion: AGENT_LAB_SCHEMA_VERSION,
		runId,
		repoRoot,
		artifactDir,
		manifestPath: join(artifactDir, "manifest.json"),
		stopRequestPath: join(artifactDir, "stop-request.json"),
		tempRoot,
		keepTemp: options.keepTemp ?? false,
		scenario: options.scenario ?? "idle",
		runtimePort: options.runtimePort ?? null,
		webPort: options.webPort ?? null,
		forwardLogs: options.forwardLogs ?? false,
	};
}

export async function persistAgentLabLaunchConfig(config: AgentLabLaunchConfig): Promise<string> {
	const configPath = join(config.artifactDir, "supervisor-config.json");
	await writeJsonAtomic(configPath, config);
	return configPath;
}
