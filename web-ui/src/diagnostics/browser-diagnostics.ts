import {
	diagnosticFindingSchema,
	diagnosticRecordEnvelopeSchema,
	diagnosticRecorderHealthSchema,
	diagnosticRecordingStateSchema,
	diagnosticSnapshotSchema,
	normalizeDiagnosticErrorClass,
	publicRuntimeDiagnosticDescriptorSchema,
} from "@runtime-contract";
import { z } from "zod";
import { getRuntimeBrowserClientId } from "@/runtime/runtime-client-id";
import type {
	BrowserDiagnosticCandidate,
	DiagnosticContext,
	DiagnosticFinding,
	DiagnosticRecordEnvelope,
	DiagnosticRecorderHealth,
	DiagnosticRecordingState,
	DiagnosticSnapshot,
	PublicRuntimeDiagnosticDescriptor,
	RuntimeStateStreamMessage,
} from "@/runtime/types";
import { BrowserDiagnosticRecordQueue, boundBrowserCandidate } from "./browser-record-queue";
import { type BrowserSnapshotContext, collectBrowserDiagnosticSnapshot } from "./browser-snapshot-collector";
import { sanitizeBrowserDiagnosticText, sanitizeBrowserDiagnosticValue } from "./browser-value-sanitizer";

const MAX_TIMELINE_RECORDS = 2_000;
const BATCH_SIZE = 25;
const FLUSH_INTERVAL_MS = 1_000;
const IS_AGENT_LAB = import.meta.env.VITE_QUARTERDECK_AGENT_LAB === "1";

type DiagnosticLevel = BrowserDiagnosticCandidate["level"];

function browserErrorClass(error: Error): string {
	return normalizeDiagnosticErrorClass(error.name);
}

export interface BrowserDiagnosticTimelineRecord {
	id: string;
	timestamp: number;
	level: DiagnosticLevel;
	source: "runtime" | "browser" | "agent-lab";
	kind: DiagnosticRecordEnvelope["kind"];
	name: string;
	context: DiagnosticContext;
	payload: unknown;
	pending: boolean;
}

export interface BrowserDiagnosticsRemoteData {
	descriptor: PublicRuntimeDiagnosticDescriptor;
	health: DiagnosticRecorderHealth;
	records: DiagnosticRecordEnvelope[];
	snapshot: DiagnosticSnapshot;
	findings: DiagnosticFinding[];
	warnings: string[];
}

const browserDiagnosticsRemoteDataSchema = z.object({
	descriptor: publicRuntimeDiagnosticDescriptorSchema,
	health: diagnosticRecorderHealthSchema,
	records: z.array(diagnosticRecordEnvelopeSchema),
	snapshot: diagnosticSnapshotSchema,
	findings: z.array(diagnosticFindingSchema),
	warnings: z.array(z.string()),
});

const browserIngestResponseSchema = z.object({ highestAcceptedSequence: z.number().int().nonnegative() });
const browserExportResponseSchema = z.object({ path: z.string().min(1) });
const browserSubscriptionResponseSchema = z.object({
	subscribed: z.boolean(),
	revision: z.number().int().nonnegative(),
	records: z.array(diagnosticRecordEnvelopeSchema),
});

export interface BrowserDiagnosticsState {
	runtimeInstanceId: string | null;
	connected: boolean;
	diagnosticCapabilityReady: boolean;
	consoleLogLevel: DiagnosticLevel;
	recording: DiagnosticRecordingState;
	timeline: BrowserDiagnosticTimelineRecord[];
	pendingCount: number;
	remoteData: BrowserDiagnosticsRemoteData | null;
	lastTransportError: string | null;
	hiddenBefore: number;
}

const INACTIVE_RECORDING: DiagnosticRecordingState = {
	active: false,
	startedAt: null,
	expiresAt: null,
	scope: null,
};

let runtimeInstanceId: string | null = null;
let capability: string | null = null;
let consoleLogLevel: DiagnosticLevel = "warn";
let recording: DiagnosticRecordingState = IS_AGENT_LAB
	? { active: true, startedAt: Date.now(), expiresAt: null, scope: { categories: [] } }
	: INACTIVE_RECORDING;
let canonicalRecords: DiagnosticRecordEnvelope[] = [];
const recordQueue = new BrowserDiagnosticRecordQueue();
let connected = false;
let remoteData: BrowserDiagnosticsRemoteData | null = null;
let lastTransportError: string | null = null;
let hiddenBefore = 0;
let flushTimer: number | null = null;
let flushInFlight = false;
let initialized = false;
let snapshotRebuildQueued = false;
let liveSubscriptionRevision = 0;
let terminalSnapshotProvider: (() => unknown) | null = null;
let snapshotContext: BrowserSnapshotContext = {
	activeProjectId: null,
	activeTaskId: null,
	boardRevision: null,
	pendingProjectPersistence: false,
};
let currentSnapshot: BrowserDiagnosticsState = createInitialSnapshot();
const listeners = new Set<() => void>();

function createInitialSnapshot(): BrowserDiagnosticsState {
	return {
		runtimeInstanceId: null,
		connected: false,
		diagnosticCapabilityReady: false,
		consoleLogLevel: "warn",
		recording: INACTIVE_RECORDING,
		timeline: [],
		pendingCount: 0,
		remoteData: null,
		lastTransportError: null,
		hiddenBefore: 0,
	};
}

function scopeMatches(context: DiagnosticContext, name: string): boolean {
	if (!recording.active || (recording.expiresAt !== null && recording.expiresAt <= Date.now())) return false;
	const scope = recording.scope;
	if (scope?.projectId && context.projectId !== scope.projectId) return false;
	if (scope?.taskId && context.taskId !== scope.taskId) return false;
	if (
		scope?.categories.length &&
		!scope.categories.some((category) => name === category || name.startsWith(`${category}.`))
	)
		return false;
	return true;
}

function createTimeline(): BrowserDiagnosticTimelineRecord[] {
	const canonical = canonicalRecords.map((record) => ({
		id: record.id,
		timestamp: record.timestamp,
		level: record.level,
		source: record.source,
		kind: record.kind,
		name: record.name,
		context: record.context,
		payload: record.payload,
		pending: false,
	}));
	const pending = recordQueue.getRecords().map((record) => ({
		id: `browser-pending:${record.clientSequence}`,
		timestamp: record.timestamp,
		level: record.level,
		source: "browser" as const,
		kind: record.kind,
		name: record.name,
		context: record.context,
		payload: record.payload,
		pending: true,
	}));
	return [...canonical, ...pending]
		.filter((record) => record.timestamp >= hiddenBefore)
		.sort((left, right) => left.timestamp - right.timestamp)
		.slice(-MAX_TIMELINE_RECORDS);
}

function rebuildSnapshot(): void {
	currentSnapshot = {
		runtimeInstanceId,
		connected,
		diagnosticCapabilityReady: capability !== null,
		consoleLogLevel,
		recording,
		timeline: createTimeline(),
		pendingCount: recordQueue.count,
		remoteData,
		lastTransportError,
		hiddenBefore,
	};
	for (const listener of listeners) listener();
}

function scheduleSnapshotRebuild(): void {
	if (snapshotRebuildQueued) return;
	snapshotRebuildQueued = true;
	queueMicrotask(() => {
		snapshotRebuildQueued = false;
		rebuildSnapshot();
	});
}

function mergeCanonical(records: readonly DiagnosticRecordEnvelope[], replace: boolean): void {
	const merged = replace ? [] : canonicalRecords;
	const byId = new Map(merged.map((record) => [record.id, record]));
	for (const record of records) byId.set(record.id, record);
	canonicalRecords = Array.from(byId.values())
		.sort((left, right) => left.sequence - right.sequence)
		.slice(-MAX_TIMELINE_RECORDS);
}

function scheduleFlush(delayMs = FLUSH_INTERVAL_MS): void {
	if (flushTimer !== null || recordQueue.count === 0 || !capability) return;
	flushTimer = window.setTimeout(() => {
		flushTimer = null;
		void flushBrowserDiagnostics();
	}, delayMs);
}

async function diagnosticRequest(
	path: string,
	init: Pick<RequestInit, "method" | "body" | "signal"> = {},
): Promise<unknown> {
	if (!capability) throw new Error("Browser diagnostics are not connected.");
	const response = await fetch(path, {
		...init,
		headers: {
			"content-type": "application/json",
			"x-quarterdeck-client-id": getRuntimeBrowserClientId(),
			"x-quarterdeck-diagnostic-capability": capability,
		},
	});
	const payload = (await response.json().catch(() => null)) as unknown;
	if (!response.ok) {
		const message =
			typeof payload === "object" && payload !== null && "error" in payload && typeof payload.error === "string"
				? payload.error
				: `Diagnostic request failed (${response.status}).`;
		throw new Error(message);
	}
	return payload;
}

async function flushBrowserDiagnostics(): Promise<void> {
	if (flushInFlight || !capability || recordQueue.count === 0) return;
	flushInFlight = true;
	const batch = recordQueue.getPendingBatch(BATCH_SIZE);
	try {
		const payload = browserIngestResponseSchema.parse(
			await diagnosticRequest("/api/diagnostics/browser-records", {
				method: "POST",
				body: JSON.stringify({ records: batch }),
			}),
		);
		recordQueue.acknowledge(payload.highestAcceptedSequence);
		lastTransportError = null;
	} catch (error) {
		lastTransportError = error instanceof Error ? error.message : String(error);
	} finally {
		flushInFlight = false;
		rebuildSnapshot();
		if (recordQueue.count > 0) scheduleFlush();
	}
}

function collectBrowserSnapshot() {
	return collectBrowserDiagnosticSnapshot({
		clientId: getRuntimeBrowserClientId(),
		connected,
		context: snapshotContext,
		terminalSnapshotProvider,
	});
}

async function submitBrowserSnapshot(nonce: string): Promise<void> {
	try {
		await diagnosticRequest("/api/diagnostics/browser-snapshot", {
			method: "POST",
			body: JSON.stringify({ nonce, snapshot: collectBrowserSnapshot() }),
		});
	} catch (error) {
		recordBrowserEvent(
			"browser.diagnostic_snapshot_failed",
			{ errorClass: error instanceof Error ? browserErrorClass(error) : "UnknownError" },
			{},
			{ level: "warn", essential: true },
		);
	}
}

export function initializeBrowserDiagnostics(): void {
	if (initialized) return;
	initialized = true;
	recordQueue.initialize();
	window.addEventListener("pagehide", recordQueue.persistNow);
	rebuildSnapshot();
	recordBrowserEvent(
		"browser.started",
		{ viewportWidth: window.innerWidth, viewportHeight: window.innerHeight },
		{},
		{
			essential: true,
		},
	);
}

export function recordBrowserEvent(
	name: string,
	payload: unknown = {},
	context: DiagnosticContext = {},
	options: { level?: DiagnosticLevel; essential?: boolean; kind?: BrowserDiagnosticCandidate["kind"] } = {},
): void {
	const level = options.level ?? "info";
	if (!options.essential && level !== "warn" && level !== "error" && !scopeMatches(context, name)) return;
	const candidate: BrowserDiagnosticCandidate = {
		version: 1,
		clientSequence: recordQueue.allocateSequence(),
		timestamp: Date.now(),
		kind: options.kind ?? "event",
		level,
		name: sanitizeBrowserDiagnosticText(name).slice(0, 256) || "browser.unnamed",
		context: sanitizeBrowserDiagnosticValue(context) as DiagnosticContext,
		payload: sanitizeBrowserDiagnosticValue(payload),
	};
	if (!recordQueue.enqueue(candidate)) return;
	scheduleSnapshotRebuild();
	scheduleFlush(recordQueue.count >= BATCH_SIZE ? 0 : FLUSH_INTERVAL_MS);
}

export function recordBrowserLog(level: DiagnosticLevel, tag: string, message: string, data?: unknown): void {
	const dataSummary = (() => {
		if (data === undefined) return undefined;
		if (data === null) return { type: "null" };
		if (data instanceof Error) return { type: "error", errorClass: browserErrorClass(data) };
		if (Array.isArray(data)) return { type: "array", entryCount: data.length };
		if (typeof data === "object") {
			try {
				return { type: "object", fieldCount: Object.keys(data).length };
			} catch {
				return { type: "object", fieldCount: 0 };
			}
		}
		return { type: typeof data };
	})();
	recordBrowserEvent(
		`log.${tag}`,
		IS_AGENT_LAB ? { tag, message, data } : { tag, messageLength: message.length, dataSummary },
		{},
		{ level, kind: "log" },
	);
}

export function handleBrowserDiagnosticsStreamMessage(message: RuntimeStateStreamMessage): boolean {
	if (message.type === "diagnostics_state") {
		const didRuntimeChange = runtimeInstanceId !== message.runtimeInstanceId;
		runtimeInstanceId = message.runtimeInstanceId;
		capability = message.browserCapability;
		consoleLogLevel = message.consoleLogLevel;
		recording = message.recording;
		remoteData = didRuntimeChange ? null : remoteData;
		mergeCanonical(message.recentRecords, didRuntimeChange);
		lastTransportError = null;
		rebuildSnapshot();
		const dropped = recordQueue.takeDroppedCount();
		if (dropped > 0) {
			recordBrowserEvent("browser.diagnostic_records_dropped", { dropped }, {}, { level: "warn", essential: true });
		}
		scheduleFlush(0);
		return true;
	}
	if (message.type === "diagnostic_record_batch") {
		mergeCanonical(message.records, false);
		rebuildSnapshot();
		return true;
	}
	if (message.type === "diagnostic_capture_state") {
		consoleLogLevel = message.consoleLogLevel;
		recording = message.recording;
		rebuildSnapshot();
		return true;
	}
	if (message.type === "diagnostic_snapshot_request") {
		if (Date.now() <= message.deadline) void submitBrowserSnapshot(message.nonce);
		return true;
	}
	return false;
}

export function setBrowserDiagnosticsConnected(nextConnected: boolean, message?: string): void {
	if (connected === nextConnected && (!message || message === lastTransportError)) return;
	connected = nextConnected;
	if (!nextConnected) capability = null;
	lastTransportError = message ?? null;
	rebuildSnapshot();
	recordBrowserEvent(
		nextConnected ? "browser.runtime_stream_connected" : "browser.runtime_stream_disconnected",
		message ? { reasonClass: "RuntimeStreamError", reasonLength: message.length } : {},
		{},
		{ level: nextConnected ? "info" : "warn", essential: true },
	);
}

export function noteBrowserRuntimeReconnect(attempt: number, delayMs: number): void {
	recordBrowserEvent("browser.runtime_stream_reconnecting", { attempt, delayMs }, {}, { essential: true });
}

export function updateBrowserSnapshotContext(update: Partial<BrowserSnapshotContext>): void {
	snapshotContext = { ...snapshotContext, ...update };
}

export function registerBrowserTerminalSnapshotProvider(provider: (() => unknown) | null): () => void {
	terminalSnapshotProvider = provider;
	return () => {
		if (terminalSnapshotProvider === provider) terminalSnapshotProvider = null;
	};
}

export async function refreshBrowserDiagnosticData(): Promise<BrowserDiagnosticsRemoteData> {
	const payload = browserDiagnosticsRemoteDataSchema.parse(await diagnosticRequest("/api/diagnostics/browser-status"));
	mergeCanonical(payload.records, false);
	remoteData = payload;
	rebuildSnapshot();
	return payload;
}

export async function setBrowserDiagnosticsLiveSubscription(subscribed: boolean): Promise<boolean> {
	const revision = ++liveSubscriptionRevision;
	const requestCapability = capability;
	const requestRuntimeInstanceId = runtimeInstanceId;
	const payload = browserSubscriptionResponseSchema.parse(
		await diagnosticRequest("/api/diagnostics/browser-subscription", {
			method: "POST",
			body: JSON.stringify({ subscribed, revision }),
		}),
	);
	if (
		payload.revision !== liveSubscriptionRevision ||
		capability !== requestCapability ||
		runtimeInstanceId !== requestRuntimeInstanceId
	) {
		return false;
	}
	if (payload.subscribed) mergeCanonical(payload.records, false);
	rebuildSnapshot();
	return payload.subscribed;
}

export async function exportBrowserDiagnosticBundle(): Promise<{ path: string }> {
	return browserExportResponseSchema.parse(
		await diagnosticRequest("/api/diagnostics/browser-export", { method: "POST", body: "{}" }),
	);
}

export async function startBrowserDeepRecording(durationMs: number): Promise<void> {
	recording = diagnosticRecordingStateSchema.parse(
		await diagnosticRequest("/api/diagnostics/browser-record", {
			method: "POST",
			body: JSON.stringify({ action: "start", durationMs, scope: {} }),
		}),
	);
	rebuildSnapshot();
}

export async function stopBrowserDeepRecording(): Promise<void> {
	recording = diagnosticRecordingStateSchema.parse(
		await diagnosticRequest("/api/diagnostics/browser-record", {
			method: "POST",
			body: JSON.stringify({ action: "stop" }),
		}),
	);
	rebuildSnapshot();
}

export function clearBrowserDiagnosticView(): void {
	hiddenBefore = Date.now();
	rebuildSnapshot();
}

export function subscribeBrowserDiagnostics(listener: () => void): () => void {
	listeners.add(listener);
	return () => listeners.delete(listener);
}

export function getBrowserDiagnosticsSnapshot(): BrowserDiagnosticsState {
	return currentSnapshot;
}

function resetForTests(): void {
	if (flushTimer !== null) window.clearTimeout(flushTimer);
	if (initialized) window.removeEventListener("pagehide", recordQueue.persistNow);
	runtimeInstanceId = null;
	capability = null;
	consoleLogLevel = "warn";
	recording = IS_AGENT_LAB
		? { active: true, startedAt: Date.now(), expiresAt: null, scope: { categories: [] } }
		: INACTIVE_RECORDING;
	canonicalRecords = [];
	recordQueue.reset();
	connected = false;
	remoteData = null;
	lastTransportError = null;
	hiddenBefore = 0;
	flushTimer = null;
	flushInFlight = false;
	initialized = false;
	snapshotRebuildQueued = false;
	liveSubscriptionRevision = 0;
	terminalSnapshotProvider = null;
	snapshotContext = {
		activeProjectId: null,
		activeTaskId: null,
		boardRevision: null,
		pendingProjectPersistence: false,
	};
	currentSnapshot = createInitialSnapshot();
	listeners.clear();
}

export const _testing = {
	boundBrowserCandidate,
	collectBrowserSnapshot,
	flushBrowserDiagnostics,
	persistTailNow: recordQueue.persistNow,
	reset: resetForTests,
};
