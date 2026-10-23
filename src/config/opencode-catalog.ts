import { execFile } from "node:child_process";
import type { RuntimeAgentId } from "../core";
import {
	armChildProcessTimeout,
	type ChildProcessTimeoutGuard,
	createTaggedLogger,
	normalizeDiagnosticErrorClass,
	resolveWindowsCompatibleCommand,
} from "../core";
import type {
	RuntimeOpencodeAgent,
	RuntimeOpencodeCatalogResponse,
	RuntimeOpencodeModel,
} from "../core/opencode-catalog-contracts";
import { assertRuntimeProcessLaunchAdmission } from "../core/runtime-process-launch-admission.js";
import { resolveAgentCommandForLaunch } from "./agent-registry";
import type { RuntimeConfigState } from "./runtime-config-normalizers";

const CATALOG_COMMAND_TIMEOUT_MS = 10_000;
const MAX_CATALOG_OUTPUT_BYTES = 4 * 1024 * 1024;
const MAX_CATALOG_ENTRIES = 5_000;
const log = createTaggedLogger("opencode-catalog");

// Strips ANSI escape sequences (color, cursor movement) so line-based parsing
// below only ever sees plain text, regardless of whether opencode's CLI
// detected an interactive TTY.
// biome-ignore lint/suspicious/noControlCharactersInRegex: Matches the ANSI escape byte itself to strip color/cursor codes.
const ANSI_ESCAPE_PATTERN = /\u001B\[[0-?]*[ -/]*[@-~]/g;

// `opencode models` prints one `provider/model` id per line (see `opencode
// facts` in the plan). Anything else on stdout (headers, blank lines, or a
// JSON blob if a caller ever passes `--verbose`) simply fails this match and
// is skipped rather than treated as a parse error.
const MODEL_LINE_PATTERN = /^([^/\s]+)\/(\S+)$/;

// `opencode agent list` prints `name (mode)` per agent, each followed by a
// JSON permission block; the JSON lines never match this pattern and are
// skipped the same way.
const AGENT_LINE_PATTERN = /^(\S+) \((primary|subagent|all)\)$/;

export interface RunOpencodeCatalogCommandOptions {
	binary: string;
	args: string[];
	cwd: string;
	env: NodeJS.ProcessEnv;
	timeoutMs: number;
	maxBufferBytes: number;
}

/** Seam for tests: returns raw stdout, or rejects on timeout/non-zero exit. */
export type RunOpencodeCatalogCommand = (options: RunOpencodeCatalogCommandOptions) => Promise<string>;

/**
 * Runs one opencode catalog subcommand (`models`, or `agent list`) through the
 * same process-launch admission and bounded-timeout mechanism the agent
 * registry uses for its `--version`/`features list` probes. Metadata-only:
 * never starts or resumes a session.
 */
export function runOpencodeCatalogCommand(options: RunOpencodeCatalogCommandOptions): Promise<string> {
	return new Promise((resolvePromise, reject) => {
		const command = resolveWindowsCompatibleCommand(options.binary, options.args);
		assertRuntimeProcessLaunchAdmission();
		let settled = false;
		let guard: ChildProcessTimeoutGuard | null = null;
		const finish = (error: Error | null, stdout: string | Buffer): void => {
			if (settled) return;
			settled = true;
			guard?.settle();
			if (guard?.isTimedOut()) {
				reject(new Error(`opencode ${options.args.join(" ")} timed out.`));
				return;
			}
			if (error) {
				reject(error);
				return;
			}
			resolvePromise(String(stdout ?? ""));
		};
		const child = execFile(
			command.binary,
			command.args,
			{
				cwd: options.cwd,
				env: options.env,
				encoding: "utf8",
				windowsHide: true,
				maxBuffer: options.maxBufferBytes,
			},
			(error, stdout) => finish(error, stdout),
		);
		if (!settled) {
			guard = armChildProcessTimeout(child, options.timeoutMs, { onAbandoned: () => finish(null, "") });
		}
	});
}

/** Exported for tests; trims, strips ANSI, and caps the number of parsed entries. */
export function parseOpencodeModelsOutput(output: string): RuntimeOpencodeModel[] {
	const models: RuntimeOpencodeModel[] = [];
	for (const rawLine of output.replace(ANSI_ESCAPE_PATTERN, "").split(/\r?\n/)) {
		const line = rawLine.trim();
		if (!line) continue;
		const match = MODEL_LINE_PATTERN.exec(line);
		if (!match) continue;
		const providerId = match[1];
		const modelId = match[2];
		if (!providerId || !modelId) continue;
		models.push({ id: line, providerId, modelId });
		if (models.length >= MAX_CATALOG_ENTRIES) break;
	}
	return models;
}

/** Exported for tests; drops `subagent`-mode agents per the catalog contract. */
export function parseOpencodeAgentListOutput(output: string): RuntimeOpencodeAgent[] {
	const agents: RuntimeOpencodeAgent[] = [];
	for (const rawLine of output.replace(ANSI_ESCAPE_PATTERN, "").split(/\r?\n/)) {
		const line = rawLine.trim();
		if (!line) continue;
		const match = AGENT_LINE_PATTERN.exec(line);
		if (!match) continue;
		const name = match[1];
		const mode = match[2];
		if (!name || mode === "subagent") continue;
		agents.push({ name, mode: mode === "all" ? "all" : "primary" });
		if (agents.length >= MAX_CATALOG_ENTRIES) break;
	}
	return agents;
}

function describeCatalogError(reason: unknown): string {
	return reason instanceof Error ? reason.message : String(reason);
}

/**
 * Metadata-only discovery: resolves the opencode command the same way a task
 * launch would (never starts or resumes a session), then runs `opencode
 * models` and `opencode agent list` concurrently. One side failing still
 * returns the other side's parsed catalog; both failing throws.
 */
export async function loadOpencodeCatalog(
	config: RuntimeConfigState,
	cwd: string,
	dependencies: {
		resolveCommand?: typeof resolveAgentCommandForLaunch;
		runCommand?: RunOpencodeCatalogCommand;
	} = {},
): Promise<RuntimeOpencodeCatalogResponse> {
	const resolveCommand = dependencies.resolveCommand ?? resolveAgentCommandForLaunch;
	const runCommand = dependencies.runCommand ?? runOpencodeCatalogCommand;
	const command = await resolveCommand({
		...config,
		// TODO(workstream A): drop the `unknown` hop once "opencode" joins RuntimeAgentId.
		selectedAgentId: "opencode" as unknown as RuntimeAgentId,
	});
	const env: NodeJS.ProcessEnv = { ...process.env, OPENCODE_DISABLE_AUTOUPDATE: "1" };
	const run = (subcommand: string[]): Promise<string> =>
		runCommand({
			binary: command.binary,
			args: [...command.args, ...subcommand],
			cwd,
			env,
			timeoutMs: CATALOG_COMMAND_TIMEOUT_MS,
			maxBufferBytes: MAX_CATALOG_OUTPUT_BYTES,
		});

	const [modelsResult, agentsResult] = await Promise.allSettled([run(["models"]), run(["agent", "list"])]);

	if (modelsResult.status === "rejected" && agentsResult.status === "rejected") {
		throw new Error(
			`opencode catalog discovery failed: models (${describeCatalogError(modelsResult.reason)}); agents (${describeCatalogError(agentsResult.reason)}).`,
		);
	}
	if (modelsResult.status === "rejected") {
		log.warn("opencode model catalog discovery failed; returning agents only", {
			errorClass: normalizeDiagnosticErrorClass(
				modelsResult.reason instanceof Error ? modelsResult.reason.name : "UnknownError",
			),
		});
	}
	if (agentsResult.status === "rejected") {
		log.warn("opencode agent catalog discovery failed; returning models only", {
			errorClass: normalizeDiagnosticErrorClass(
				agentsResult.reason instanceof Error ? agentsResult.reason.name : "UnknownError",
			),
		});
	}

	return {
		models: modelsResult.status === "fulfilled" ? parseOpencodeModelsOutput(modelsResult.value) : [],
		agents: agentsResult.status === "fulfilled" ? parseOpencodeAgentListOutput(agentsResult.value) : [],
	};
}
