#!/usr/bin/env node

import { unlink } from "node:fs/promises";

import { createAgentLabLaunchConfig, persistAgentLabLaunchConfig } from "./agent-lab/launch-config";
import { AGENT_LAB_REPO_ROOT, writeJsonAtomic } from "./agent-lab/paths";
import { runAgentLabSupervisor } from "./agent-lab/supervisor";

function parsePort(value: string | undefined, fallback: number): number {
	const parsed = Number.parseInt(value ?? String(fallback), 10);
	if (!Number.isInteger(parsed) || parsed < 1 || parsed > 65_535) {
		throw new Error(`Invalid Playwright E2E port: ${JSON.stringify(value)}`);
	}
	return parsed;
}

const config = await createAgentLabLaunchConfig({
	name: "playwright",
	repoRoot: AGENT_LAB_REPO_ROOT,
	runtimePort: parsePort(process.env.QUARTERDECK_E2E_RUNTIME_PORT, 3597),
	webPort: parsePort(process.env.QUARTERDECK_E2E_WEB_PORT, 4174),
	scenario: "idle",
	forwardLogs: true,
});
await persistAgentLabLaunchConfig(config);
const manifestPointerPath = process.env.QUARTERDECK_E2E_MANIFEST_POINTER_PATH;
if (!manifestPointerPath) throw new Error("Playwright fixture discovery path is required.");
await writeJsonAtomic(manifestPointerPath, { manifestPath: config.manifestPath });
process.stderr.write(`[agent-lab e2e] artifacts: ${config.artifactDir}\n`);
try {
	await runAgentLabSupervisor(config);
} finally {
	await unlink(manifestPointerPath).catch((error: unknown) => {
		if (!(error && typeof error === "object" && "code" in error && error.code === "ENOENT")) throw error;
	});
}
