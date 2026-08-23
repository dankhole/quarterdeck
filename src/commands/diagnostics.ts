import { setTimeout as delay } from "node:timers/promises";

import type { Command } from "commander";
import { z } from "zod";

import {
	type DiagnosticRecordEnvelope,
	diagnosticRecordEnvelopeSchema,
	diagnosticStatusSchema,
	publicRuntimeDiagnosticDescriptorSchema,
} from "../core";
import {
	collectDiagnosticCapture,
	type DiscoveredRuntimeDiagnosticInstance,
	diagnosticFilterQuery,
	diagnosticRuntimeUrl,
	discoverRuntimeDiagnosticInstances,
	matchesDiagnosticRecordFilter,
	probeRuntimeDiagnosticInstance,
	RuntimeDiagnosticClientError,
	requestRuntimeDiagnostic,
	selectRuntimeDiagnosticInstance,
	writeDiagnosticBundle,
} from "../diagnostics";
import type { DiagnosticRecordFilter } from "../diagnostics/diagnostic-record";

const MAX_WATCH_DURATION_MS = 15 * 60_000;
const MAX_RECORDING_DURATION_MS = 15 * 60_000;

class DiagnosticsCommandError extends Error {
	constructor(
		message: string,
		readonly exitCode: number,
	) {
		super(message);
		this.name = "DiagnosticsCommandError";
	}
}

interface InstanceSelectionOptions {
	instance?: string;
	latest?: boolean;
}

interface FilterOptions {
	project?: string;
	task?: string;
	session?: string;
	operation?: string;
	source?: string;
	level?: string;
	event?: string;
	since?: string;
	until?: string;
}

interface JsonOption {
	json?: boolean;
}

const recordsResponseSchema = z.object({ records: z.array(diagnosticRecordEnvelopeSchema) });

function parseDuration(value: string, maximumMs: number): number {
	const match = /^(\d+(?:\.\d+)?)(ms|s|m|h)$/u.exec(value.trim().toLowerCase());
	if (!match) throw new DiagnosticsCommandError(`Invalid duration: ${value}. Use ms, s, m, or h.`, 1);
	const amount = Number(match[1]);
	const unit = match[2];
	const multiplier = unit === "ms" ? 1 : unit === "s" ? 1_000 : unit === "m" ? 60_000 : 3_600_000;
	const durationMs = Math.round(amount * multiplier);
	if (!Number.isFinite(durationMs) || durationMs < 1 || durationMs > maximumMs) {
		throw new DiagnosticsCommandError(`Duration must be between 1ms and ${Math.floor(maximumMs / 60_000)}m.`, 1);
	}
	return durationMs;
}

function parseTimestamp(value: string): number {
	if (/^\d+$/u.test(value)) return Number(value);
	const parsed = Date.parse(value);
	if (!Number.isFinite(parsed)) throw new DiagnosticsCommandError(`Invalid timestamp: ${value}`, 1);
	return parsed;
}

function buildFilter(options: FilterOptions): DiagnosticRecordFilter {
	const source = options.source as DiagnosticRecordFilter["source"] | string | undefined;
	if (source && source !== "runtime" && source !== "browser" && source !== "agent-lab") {
		throw new DiagnosticsCommandError(`Invalid diagnostic source: ${source}`, 1);
	}
	const level = options.level as DiagnosticRecordFilter["level"] | string | undefined;
	if (level && level !== "debug" && level !== "info" && level !== "warn" && level !== "error") {
		throw new DiagnosticsCommandError(`Invalid diagnostic level: ${level}`, 1);
	}
	return {
		...(options.project ? { projectId: options.project } : {}),
		...(options.task ? { taskId: options.task } : {}),
		...(options.session ? { sessionInstanceId: options.session } : {}),
		...(options.operation ? { operationId: options.operation } : {}),
		...(source ? { source: source as DiagnosticRecordFilter["source"] } : {}),
		...(level ? { level: level as DiagnosticRecordFilter["level"] } : {}),
		...(options.event ? { name: options.event } : {}),
		...(options.since ? { since: Date.now() - parseDuration(options.since, 365 * 24 * 60 * 60_000) } : {}),
		...(options.until ? { until: parseTimestamp(options.until) } : {}),
	};
}

async function requestRuntime(
	instance: DiscoveredRuntimeDiagnosticInstance,
	pathname: string,
	options: { method?: "GET" | "POST"; body?: unknown; timeoutMs?: number } = {},
): Promise<unknown> {
	try {
		return await requestRuntimeDiagnostic(instance, pathname, options);
	} catch (error) {
		if (error instanceof RuntimeDiagnosticClientError) {
			throw new DiagnosticsCommandError(error.message, error.status === null || error.status === 403 ? 3 : 1);
		}
		throw error;
	}
}

async function selectInstance(options: InstanceSelectionOptions): Promise<DiscoveredRuntimeDiagnosticInstance> {
	const selected = await selectRuntimeDiagnosticInstance({ instanceId: options.instance });
	if (!selected) throw new DiagnosticsCommandError("No matching Quarterdeck diagnostic runtime was found.", 2);
	return selected;
}

function addSelectionOptions(command: Command): Command {
	return command
		.option("--latest", "Use the newest active or finalized runtime instance (default).")
		.option("--instance <id>", "Use a specific runtime instance id.");
}

function addFilterOptions(command: Command): Command {
	return command
		.option("--project <id>", "Filter by project id.")
		.option("--task <id>", "Filter by task id.")
		.option("--session <id>", "Filter by session instance id.")
		.option("--operation <id>", "Filter by operation id.")
		.option("--source <source>", "Filter by source: runtime, browser, or agent-lab.")
		.option("--level <level>", "Filter by level: debug, info, warn, or error.")
		.option("--event <name>", "Filter by event/log name prefix.")
		.option("--since <duration>", "Include records from the recent duration (for example 10m).")
		.option("--until <timestamp>", "Include records through an ISO timestamp or epoch milliseconds.");
}

function addJsonOption(command: Command): Command {
	return command.option("--json", "Print stable machine-readable JSON.");
}

function printJson(value: unknown): void {
	console.log(JSON.stringify(value, null, 2));
}

function printRecord(record: DiagnosticRecordEnvelope): void {
	const context = [record.context.projectId, record.context.taskId, record.context.sessionInstanceId]
		.filter(Boolean)
		.join("/");
	console.log(
		`${new Date(record.timestamp).toISOString()} ${record.level.padEnd(5)} ${record.name}${context ? ` [${context}]` : ""}`,
	);
}

function setCommandFailure(error: unknown): void {
	const commandError =
		error instanceof DiagnosticsCommandError
			? error
			: new DiagnosticsCommandError(error instanceof Error ? error.message : String(error), 1);
	console.error(commandError.message);
	process.exitCode = commandError.exitCode;
}

async function collectCapture(
	instance: DiscoveredRuntimeDiagnosticInstance,
	filter: DiagnosticRecordFilter,
	requestBrowser: boolean,
) {
	try {
		return await collectDiagnosticCapture(instance, { filter, requestBrowser, fallbackToJournal: true });
	} catch (error) {
		if (error instanceof RuntimeDiagnosticClientError) {
			throw new DiagnosticsCommandError(error.message, error.status === null || error.status === 403 ? 3 : 1);
		}
		throw error;
	}
}

export function registerDiagnosticsCommand(program: Command): void {
	const diagnostics = program.command("diagnostics").description("Inspect Quarterdeck's private local diagnostics.");

	addJsonOption(
		diagnostics.command("list").description("List active and recently retained runtime instances."),
	).action(async (options: JsonOption) => {
		try {
			const instances = await discoverRuntimeDiagnosticInstances();
			const result = await Promise.all(
				instances.map(async (instance) => {
					const probe = await probeRuntimeDiagnosticInstance(instance);
					return {
						descriptor: publicRuntimeDiagnosticDescriptorSchema.parse(instance.descriptor),
						pidAlive: instance.pidAlive,
						reachable: probe.reachable,
						instanceMatches: probe.instanceMatches,
						journalAvailable: instance.descriptor.journalDirectory.length > 0,
					};
				}),
			);
			if (options.json) printJson({ instances: result });
			else if (result.length === 0) console.log("No Quarterdeck diagnostic runtimes found.");
			else {
				for (const instance of result) {
					console.log(
						`${instance.descriptor.runtimeInstanceId}  ${instance.descriptor.status.padEnd(8)}  pid=${instance.descriptor.pid} (${instance.pidAlive ? "alive" : "not alive"})  ${instance.reachable && instance.instanceMatches ? "authenticated" : "offline/unverified"}  ${instance.descriptor.host}:${instance.descriptor.port}  ${instance.descriptor.startedAt}`,
					);
				}
			}
		} catch (error) {
			setCommandFailure(error);
		}
	});

	addJsonOption(
		addSelectionOptions(diagnostics.command("status").description("Show lightweight recorder status.")),
	).action(async (options: InstanceSelectionOptions & JsonOption) => {
		try {
			const instance = await selectInstance(options);
			if (!instance.pidAlive) {
				const result = {
					descriptor: publicRuntimeDiagnosticDescriptorSchema.parse(instance.descriptor),
					reachable: false,
					health: null,
				};
				if (options.json) printJson(result);
				else console.log(`${result.descriptor.runtimeInstanceId}: ${result.descriptor.status}; process not alive.`);
				return;
			}
			const status = diagnosticStatusSchema.parse(await requestRuntime(instance, "/api/diagnostics/status"));
			if (options.json) printJson({ ...status, reachable: true });
			else {
				console.log(
					`${status.descriptor.runtimeInstanceId}: ${status.descriptor.status} on ${status.descriptor.host}:${status.descriptor.port}`,
				);
				console.log(
					`records=${status.health.recordCount}, pending=${status.health.pendingJournalRecords}, dropped=${status.health.droppedRecords}, journal=${status.health.journalHealthy ? "healthy" : "degraded"}`,
				);
			}
		} catch (error) {
			setCommandFailure(error);
		}
	});

	const doctor = addJsonOption(
		addFilterOptions(
			addSelectionOptions(diagnostics.command("doctor").description("Run read-only diagnostic checks.")),
		),
	)
		.option("--request-browser", "Request a fresh metadata-only browser snapshot.")
		.option("--fail-on-error", "Exit 5 when an error-severity finding is present.");
	doctor.action(
		async (
			options: InstanceSelectionOptions &
				FilterOptions &
				JsonOption & { requestBrowser?: boolean; failOnError?: boolean },
		) => {
			try {
				const instance = await selectInstance(options);
				const data = await collectCapture(instance, buildFilter(options), options.requestBrowser === true);
				const result = { snapshot: data.snapshot, findings: data.findings, warnings: data.warnings };
				if (options.json) printJson(result);
				else if (data.findings.length === 0) console.log("No diagnostic findings.");
				else
					for (const finding of data.findings)
						console.log(`${finding.severity.toUpperCase()} ${finding.code}: ${finding.summary}`);
				if (options.failOnError && data.findings.some((finding) => finding.severity === "error"))
					process.exitCode = 5;
			} catch (error) {
				setCommandFailure(error);
			}
		},
	);

	const capture = addJsonOption(
		addFilterOptions(
			addSelectionOptions(diagnostics.command("capture").description("Write a canonical local diagnostic bundle.")),
		),
	)
		.option("--output <directory>", "Write to this new directory.")
		.option("--request-browser", "Request a fresh metadata-only browser snapshot.");
	capture.action(
		async (
			options: InstanceSelectionOptions &
				FilterOptions &
				JsonOption & {
					output?: string;
					requestBrowser?: boolean;
				},
		) => {
			try {
				const instance = await selectInstance(options);
				const filter = buildFilter(options);
				const data = await collectCapture(instance, filter, options.requestBrowser === true);
				const result = await writeDiagnosticBundle({
					quarterdeckVersion: data.descriptor.quarterdeckVersion,
					descriptor: data.descriptor,
					records: data.records,
					snapshot: data.snapshot,
					findings: data.findings,
					health: data.health,
					warnings: data.warnings,
					projectId: options.project ?? null,
					taskId: options.task ?? null,
					outputDirectory: options.output,
				});
				const output = {
					path: result.path,
					runtimeInstanceId: result.manifest.runtimeInstanceId,
					status: result.manifest.status,
					timeRange: result.manifest.timeRange,
					warnings: result.manifest.warnings,
					findingCounts: result.manifest.findingCounts,
				};
				if (options.json) printJson(output);
				else
					console.log(
						`Diagnostic bundle written: ${result.path}${result.manifest.status === "partial" ? " (partial)" : ""}`,
					);
			} catch (error) {
				setCommandFailure(error);
			}
		},
	);

	const watch = addFilterOptions(
		addSelectionOptions(diagnostics.command("watch").description("Watch bounded diagnostic records.")),
	)
		.option("--duration <duration>", "Maximum watch duration (default 60s).", "60s")
		.option("--jsonl", "Print one JSON record per line.");
	watch.action(async (options: InstanceSelectionOptions & FilterOptions & { duration: string; jsonl?: boolean }) => {
		try {
			const instance = await selectInstance(options);
			if (!instance.pidAlive) throw new DiagnosticsCommandError("Cannot watch a finalized runtime instance.", 3);
			const durationMs = parseDuration(options.duration, MAX_WATCH_DURATION_MS);
			const filter = buildFilter(options);
			let lastSequence = filter.afterSequence ?? 0;
			const deadline = Date.now() + durationMs;
			while (Date.now() < deadline) {
				const queryFilter = { ...filter, afterSequence: lastSequence };
				const payload = recordsResponseSchema.parse(
					await requestRuntime(instance, `/api/diagnostics/records${diagnosticFilterQuery(queryFilter)}`),
				);
				for (const record of payload.records) {
					lastSequence = Math.max(lastSequence, record.sequence);
					if (options.jsonl) console.log(JSON.stringify(record));
					else printRecord(record);
				}
				await delay(Math.min(500, Math.max(0, deadline - Date.now())));
			}
		} catch (error) {
			setCommandFailure(error);
		}
	});

	const record = addJsonOption(
		addSelectionOptions(diagnostics.command("record").description("Control time-bounded deep recording.")),
	)
		.option("--duration <duration>", "Start recording for this duration (maximum 15m).")
		.option("--project <id>", "Scope recording to a project.")
		.option("--task <id>", "Scope recording to a task.")
		.option("--category <name...>", "Restrict recording to category prefixes.")
		.option("--stop", "Stop the active deep-recording window.")
		.option("--status", "Show current recording state.");
	record.action(
		async (
			options: InstanceSelectionOptions &
				JsonOption & {
					duration?: string;
					project?: string;
					task?: string;
					category?: string[];
					stop?: boolean;
					status?: boolean;
				},
		) => {
			try {
				const instance = await selectInstance(options);
				let result: unknown;
				if (options.status) {
					result = diagnosticStatusSchema.parse(await requestRuntime(instance, "/api/diagnostics/status")).health
						.recording;
				} else {
					if (!options.stop && !options.duration) {
						throw new DiagnosticsCommandError("Specify --duration, --stop, or --status.", 1);
					}
					result = await requestRuntime(instance, "/api/diagnostics/record", {
						method: "POST",
						body: options.stop
							? { action: "stop" }
							: {
									action: "start",
									durationMs: parseDuration(options.duration ?? "", MAX_RECORDING_DURATION_MS),
									scope: {
										...(options.project ? { projectId: options.project } : {}),
										...(options.task ? { taskId: options.task } : {}),
										categories: options.category ?? [],
									},
								},
					});
				}
				if (options.json) printJson(result);
				else printJson(result);
			} catch (error) {
				setCommandFailure(error);
			}
		},
	);

	addJsonOption(
		addSelectionOptions(diagnostics.command("mark <message>").description("Add a bounded diagnostic timeline mark.")),
	)
		.option("--project <id>", "Associate the mark with a project.")
		.option("--task <id>", "Associate the mark with a task.")
		.action(
			async (
				message: string,
				options: InstanceSelectionOptions & JsonOption & { project?: string; task?: string },
			) => {
				try {
					const instance = await selectInstance(options);
					const result = await requestRuntime(instance, "/api/diagnostics/mark", {
						method: "POST",
						body: {
							message,
							context: {
								...(options.project ? { projectId: options.project } : {}),
								...(options.task ? { taskId: options.task } : {}),
							},
						},
					});
					if (options.json) printJson(result);
					else console.log(`Diagnostic mark added to ${instance.descriptor.runtimeInstanceId}.`);
				} catch (error) {
					setCommandFailure(error);
				}
			},
		);
}

export const _testing = {
	buildFilter,
	diagnosticUrl: diagnosticRuntimeUrl,
	matchesFilter: matchesDiagnosticRecordFilter,
	parseDuration,
	parseTimestamp,
};
