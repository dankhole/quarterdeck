#!/usr/bin/env node

import { runAgentLabCli } from "./agent-lab/cli";

runAgentLabCli().catch((error: unknown) => {
	process.stderr.write(`[agent-lab] ${error instanceof Error ? error.message : String(error)}\n`);
	process.exitCode = 1;
});
