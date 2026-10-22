import { HOOK_METADATA_FLAG_SPECS, type HookCommandMetadataOptionValues } from "./commands/hook-metadata.js";
import { parseHookEvent, runHooksIngest, runHooksNotify } from "./hooks-runtime-client.js";

/**
 * Argv parsing and dispatch for the lightweight standalone bundle (`dist/hooks.js`,
 * built from `hook-main.ts` by `scripts/build.mjs`) for `hooks ingest|notify`.
 * Deliberately has no commander: every Claude/Codex/Pi hook fires a full process,
 * so this entry must stay a minimal, narrowly-imported bundle (see
 * `hooks-runtime-client.ts`). It accepts the exact same argv shape commander
 * produced for `quarterdeck hooks <ingest|notify> --event <event> [--flag
 * value|--flag=value ...] [--] [payload]`, which
 * `claude-hooks.ts`/`codex-hooks.ts`/the Pi lifecycle extension already build.
 *
 * This module has no side effects on import (no top-level `main()` call) so it
 * can be imported directly by tests; `hook-main.ts` is the only file that
 * invokes `main()`, matching `src/cli.ts`'s own separation between its program
 * definition and its `void run()...` entry-point side effect.
 */

export interface ParsedHookEntryArgs {
	event: string;
	options: HookCommandMetadataOptionValues;
	payload: string | undefined;
	/** The first `--flag` with no matching spec, mirroring commander's unknownOption error. */
	unknownFlag: string | null;
}

export function parseHookEntryArgs(tokens: string[]): ParsedHookEntryArgs {
	const options: HookCommandMetadataOptionValues = {};
	let event: string | undefined;
	let payload: string | undefined;
	let endOfOptions = false;
	let unknownFlag: string | null = null;

	for (let index = 0; index < tokens.length; index += 1) {
		const token = tokens[index];
		if (token === undefined) {
			continue;
		}
		if (!endOfOptions && token === "--") {
			endOfOptions = true;
			continue;
		}
		if (!endOfOptions && token.startsWith("--")) {
			const equalsIndex = token.indexOf("=");
			const flagName = equalsIndex === -1 ? token : token.slice(0, equalsIndex);
			const inlineValue = equalsIndex === -1 ? undefined : token.slice(equalsIndex + 1);
			if (flagName === "--event") {
				event = inlineValue ?? tokens[index + 1];
				if (inlineValue === undefined) {
					index += 1;
				}
				continue;
			}
			const spec = HOOK_METADATA_FLAG_SPECS.find((candidate) => candidate.flag === flagName);
			if (!spec) {
				unknownFlag = flagName;
				break;
			}
			const value = inlineValue ?? tokens[index + 1];
			if (inlineValue === undefined) {
				index += 1;
			}
			if (value !== undefined) {
				options[spec.key] = value;
			}
			continue;
		}
		if (payload === undefined) {
			payload = token;
		}
	}

	return { event: event ?? "", options, payload, unknownFlag };
}

export async function main(): Promise<void> {
	const argv = process.argv.slice(2);
	const subcommand = argv[1];
	if (argv[0] !== "hooks" || (subcommand !== "ingest" && subcommand !== "notify")) {
		process.stderr.write("Usage: quarterdeck hooks <ingest|notify> --event <event> [options] [payload]\n");
		process.exitCode = 1;
		return;
	}

	const { event, options, payload, unknownFlag } = parseHookEntryArgs(argv.slice(2));
	if (unknownFlag) {
		// Commander rejects an unrecognized option before either action handler ever
		// runs, for both ingest and notify alike; match that here.
		process.stderr.write(`error: unknown option '${unknownFlag}'\n`);
		process.exitCode = 1;
		return;
	}

	try {
		const parsedEvent = parseHookEvent(event);
		if (subcommand === "ingest") {
			await runHooksIngest(parsedEvent, options, payload);
		} else {
			await runHooksNotify(parsedEvent, options, payload);
		}
	} catch (error) {
		if (subcommand === "notify") {
			// Best effort only, matching runHooksNotify's own swallowed-error contract.
			return;
		}
		process.stderr.write(`quarterdeck hooks ingest: ${error instanceof Error ? error.message : String(error)}\n`);
		process.exitCode = 1;
	}
}
