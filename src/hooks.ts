import { Command } from "commander";

import { registerHooksCommand } from "./commands/hooks";
import { registerStatuslineCommand } from "./commands/statusline";

/**
 * Dedicated entrypoint for provider hook commands (`hooks ingest|notify`) and
 * `statusline`. Claude fires PreToolUse/PostToolUse on every tool call, and
 * Codex/Pi fire comparable hooks; `cli.js` is a multi-megabyte bundle that
 * also wires the full server/router graph, so reinvoking it for every hook
 * costs real startup time under parallel-agent load. This bundle imports only
 * the hooks/statusline command modules so the per-invocation parse/eval cost
 * stays small. `buildQuarterdeckHookCommandLine` (src/core/quarterdeck-command.ts)
 * is what points newly generated provider settings at this file instead of
 * `cli.js`; `quarterdeck hooks ingest|notify` and `quarterdeck statusline`
 * keep working unchanged through `cli.js` for already-running sessions whose
 * settings still reference it.
 */
function createHooksProgram(): Command {
	const program = new Command();
	program.name("quarterdeck");
	registerHooksCommand(program);
	registerStatuslineCommand(program);
	return program;
}

async function run(): Promise<void> {
	const argv = process.argv.slice(2);
	await createHooksProgram().parseAsync(argv, { from: "user" });
	process.exit(process.exitCode ?? 0);
}

void run().catch((error: unknown) => {
	const message = error instanceof Error ? error.message : String(error);
	process.stderr.write(`Failed to run Quarterdeck hook command: ${message}\n`);
	process.exit(1);
});
