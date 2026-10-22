import type { Command } from "commander";

import type { RuntimeHookEvent } from "../core/api/task-session.js";
import { parseHookEvent, runHooksIngest, runHooksNotify } from "../hooks-runtime-client.js";
import { HOOK_METADATA_FLAG_SPECS, type HookCommandMetadataOptionValues } from "./hook-metadata";

// Keeps `quarterdeck hooks ingest|notify` working inside dist/cli.js for installed
// settings and running sessions that still point at the full CLI. The actual
// implementation — shared with the lightweight dist/hooks.js entry — lives in
// ../hooks-runtime-client.ts; this file only wires it into commander.

function applyHookMetadataOptions<T extends Command>(command: T): T {
	for (const { flag, description } of HOOK_METADATA_FLAG_SPECS) {
		command.option(`${flag} <value>`, description);
	}
	return command;
}

export function registerHooksCommand(program: Command): void {
	const hooks = program.command("hooks").description("Runtime hook helpers for agent integrations.");

	applyHookMetadataOptions(
		hooks
			.command("ingest [payload]")
			.description("Ingest hook event into Quarterdeck runtime.")
			.requiredOption("--event <event>", "Event: to_review | to_in_progress | activity.", parseHookEvent),
	).action(
		async (payload: string | undefined, options: HookCommandMetadataOptionValues & { event: RuntimeHookEvent }) => {
			await runHooksIngest(options.event, options, payload);
		},
	);

	applyHookMetadataOptions(
		hooks
			.command("notify [payload]")
			.description("Best-effort hook ingest that never throws.")
			.requiredOption("--event <event>", "Event: to_review | to_in_progress | activity.", parseHookEvent),
	).action(
		async (payload: string | undefined, options: HookCommandMetadataOptionValues & { event: RuntimeHookEvent }) => {
			await runHooksNotify(options.event, options, payload);
		},
	);
}
