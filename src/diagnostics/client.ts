import { z } from "zod";

import {
	type DiagnosticFinding,
	type DiagnosticRecordEnvelope,
	type DiagnosticRecorderHealth,
	type DiagnosticSnapshot,
	diagnosticFindingSchema,
	diagnosticRecordEnvelopeSchema,
	diagnosticRecorderHealthSchema,
	diagnosticSnapshotSchema,
	diagnosticStatusSchema,
	normalizeDiagnosticErrorClass,
	publicRuntimeDiagnosticDescriptorSchema,
	type RuntimeDiagnosticDescriptor,
} from "../core";
import {
	captureScopeFromRecordFilter,
	type DiagnosticRecordFilter,
	mergeDiagnosticRecordSources,
} from "./diagnostic-record";
import { evaluateDiagnosticSnapshot } from "./doctor";
import { readDiagnosticJournal } from "./journal";
import { type DiscoveredRuntimeDiagnosticInstance, discoverRuntimeDiagnosticInstances } from "./runtime-instance";

const liveCaptureSchema = z.object({
	descriptor: publicRuntimeDiagnosticDescriptorSchema,
	health: diagnosticRecorderHealthSchema,
	records: z.array(diagnosticRecordEnvelopeSchema),
	snapshot: diagnosticSnapshotSchema,
	findings: z.array(diagnosticFindingSchema),
	warnings: z.array(z.string()),
});

export interface CollectedDiagnosticCapture {
	descriptor: ReturnType<typeof publicRuntimeDiagnosticDescriptorSchema.parse>;
	health: DiagnosticRecorderHealth | null;
	records: DiagnosticRecordEnvelope[];
	snapshot: DiagnosticSnapshot;
	findings: DiagnosticFinding[];
	warnings: string[];
}

export class RuntimeDiagnosticClientError extends Error {
	constructor(
		message: string,
		readonly status: number | null = null,
	) {
		super(message);
		this.name = "RuntimeDiagnosticClientError";
	}
}

export interface RuntimeDiagnosticProbeResult {
	reachable: boolean;
	instanceMatches: boolean;
}

export function diagnosticRuntimeUrl(descriptor: RuntimeDiagnosticDescriptor, pathname: string): URL {
	let host = descriptor.host;
	if (host === "0.0.0.0" || host === "::") host = "127.0.0.1";
	const bracketedHost = host.includes(":") && !host.startsWith("[") ? `[${host}]` : host;
	return new URL(pathname, `http://${bracketedHost}:${descriptor.port}`);
}

export async function requestRuntimeDiagnostic(
	instance: DiscoveredRuntimeDiagnosticInstance,
	pathname: string,
	options: { method?: "GET" | "POST"; body?: unknown; timeoutMs?: number } = {},
): Promise<unknown> {
	let response: Response;
	try {
		response = await fetch(diagnosticRuntimeUrl(instance.descriptor, pathname), {
			method: options.method ?? "GET",
			headers: {
				"content-type": "application/json",
				"x-quarterdeck-diagnostic-token": instance.descriptor.diagnosticToken,
			},
			body: options.body === undefined ? undefined : JSON.stringify(options.body),
			signal: AbortSignal.timeout(options.timeoutMs ?? 3_000),
		});
	} catch (error) {
		throw new RuntimeDiagnosticClientError(
			`Runtime ${instance.descriptor.runtimeInstanceId} is not reachable: ${error instanceof Error ? error.message : String(error)}`,
		);
	}
	const payload = (await response.json().catch(() => null)) as unknown;
	if (!response.ok) {
		const message =
			typeof payload === "object" && payload !== null && "error" in payload && typeof payload.error === "string"
				? payload.error
				: `HTTP ${response.status}`;
		throw new RuntimeDiagnosticClientError(`Diagnostic request failed: ${message}`, response.status);
	}
	return payload;
}

export async function probeRuntimeDiagnosticInstance(
	instance: DiscoveredRuntimeDiagnosticInstance,
	timeoutMs = 750,
): Promise<RuntimeDiagnosticProbeResult> {
	if (!instance.pidAlive || instance.descriptor.status === "stopped" || instance.descriptor.status === "failed") {
		return { reachable: false, instanceMatches: false };
	}
	try {
		const status = diagnosticStatusSchema.parse(
			await requestRuntimeDiagnostic(instance, "/api/diagnostics/status", { timeoutMs }),
		);
		return {
			reachable: true,
			instanceMatches: status.descriptor.runtimeInstanceId === instance.descriptor.runtimeInstanceId,
		};
	} catch {
		return { reachable: false, instanceMatches: false };
	}
}

export function diagnosticFilterQuery(filter: DiagnosticRecordFilter): string {
	const query = new URLSearchParams();
	for (const [key, value] of Object.entries(filter)) {
		if (value !== undefined) query.set(key, String(value));
	}
	const encoded = query.toString();
	return encoded ? `?${encoded}` : "";
}

export async function selectRuntimeDiagnosticInstance(
	options: { stateHome?: string; instanceId?: string; runtimePid?: number } = {},
): Promise<DiscoveredRuntimeDiagnosticInstance | null> {
	const instances = await discoverRuntimeDiagnosticInstances(options.stateHome);
	if (options.instanceId) {
		return instances.find((instance) => instance.descriptor.runtimeInstanceId === options.instanceId) ?? null;
	}
	if (options.runtimePid) {
		const matchingPid = instances.find((instance) => instance.descriptor.pid === options.runtimePid);
		if (matchingPid) return matchingPid;
	}
	const active = instances.filter(
		(instance) =>
			instance.pidAlive &&
			(instance.descriptor.status === "ready" ||
				instance.descriptor.status === "starting" ||
				instance.descriptor.status === "stopping"),
	);
	const probes = await Promise.all(
		active.map(async (instance) => ({
			instance,
			probe: await probeRuntimeDiagnosticInstance(instance),
		})),
	);
	const authenticated = probes.find(({ probe }) => probe.reachable && probe.instanceMatches);
	if (authenticated) return authenticated.instance;
	return instances.find((instance) => !active.includes(instance)) ?? active[0] ?? null;
}

async function collectOfflineCapture(
	instance: DiscoveredRuntimeDiagnosticInstance,
	filter: DiagnosticRecordFilter,
): Promise<CollectedDiagnosticCapture> {
	const journal = await readDiagnosticJournal(instance.descriptor.journalDirectory);
	const records = mergeDiagnosticRecordSources([journal.records], filter);
	const snapshot: DiagnosticSnapshot = {
		version: 1,
		runtimeInstanceId: instance.descriptor.runtimeInstanceId,
		capturedAt: Date.now(),
		scope: captureScopeFromRecordFilter(filter),
		providers: [
			{
				name: "runtime",
				status: "unavailable",
				durationMs: 0,
				error: "Runtime is not reachable; current in-memory snapshots are unavailable.",
			},
		],
	};
	return {
		descriptor: publicRuntimeDiagnosticDescriptorSchema.parse(instance.descriptor),
		health: null,
		records,
		snapshot,
		findings: evaluateDiagnosticSnapshot(snapshot, records),
		warnings: [
			"Offline capture: current subsystem snapshots and recorder health are unavailable.",
			...journal.warnings,
		],
	};
}

export async function collectDiagnosticCapture(
	instance: DiscoveredRuntimeDiagnosticInstance,
	options: { filter?: DiagnosticRecordFilter; requestBrowser?: boolean; fallbackToJournal?: boolean } = {},
): Promise<CollectedDiagnosticCapture> {
	const filter = options.filter ?? {};
	if (!instance.pidAlive || instance.descriptor.status === "stopped" || instance.descriptor.status === "failed") {
		return await collectOfflineCapture(instance, filter);
	}
	try {
		const raw = await requestRuntimeDiagnostic(instance, `/api/diagnostics/capture${diagnosticFilterQuery(filter)}`, {
			method: "POST",
			body: { requestBrowser: options.requestBrowser === true },
			timeoutMs: options.requestBrowser ? 7_500 : 5_000,
		});
		return liveCaptureSchema.parse(raw);
	} catch (error) {
		if (!options.fallbackToJournal) throw error;
		const offline = await collectOfflineCapture(instance, filter);
		return {
			...offline,
			warnings: [
				`Live diagnostic capture failed (${error instanceof Error ? normalizeDiagnosticErrorClass(error.name) : "UnknownError"}); journal fallback used.`,
				...offline.warnings,
			],
		};
	}
}
