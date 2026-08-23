import { z } from "zod";

const DIAGNOSTIC_ERROR_CLASS_PATTERN = /^[A-Za-z][A-Za-z0-9_.-]{0,127}$/u;

export function normalizeDiagnosticErrorClass(value: string): string {
	const normalized = value.trim();
	return DIAGNOSTIC_ERROR_CLASS_PATTERN.test(normalized) ? normalized : "UnknownError";
}

export const DIAGNOSTIC_SCHEMA_VERSION = 1 as const;

export const diagnosticLevelSchema = z.enum(["debug", "info", "warn", "error"]);
export type DiagnosticLevel = z.infer<typeof diagnosticLevelSchema>;

export const diagnosticSourceSchema = z.enum(["runtime", "browser", "agent-lab"]);
export type DiagnosticSource = z.infer<typeof diagnosticSourceSchema>;

export const diagnosticRecordKindSchema = z.enum(["event", "log", "mark", "recorder_health"]);
export type DiagnosticRecordKind = z.infer<typeof diagnosticRecordKindSchema>;

export const diagnosticContextSchema = z.object({
	operationId: z.string().min(1).max(128).optional(),
	parentOperationId: z.string().min(1).max(128).optional(),
	projectId: z.string().min(1).max(256).optional(),
	taskId: z.string().min(1).max(256).optional(),
	sessionInstanceId: z.string().min(1).max(256).optional(),
	clientId: z.string().min(1).max(256).optional(),
	connectionId: z.string().min(1).max(256).optional(),
	deliveryId: z.string().min(1).max(256).optional(),
	requestId: z.string().min(1).max(256).optional(),
});
export type DiagnosticContext = z.infer<typeof diagnosticContextSchema>;

export const diagnosticCaptureScopeSchema = diagnosticContextSchema.pick({
	projectId: true,
	taskId: true,
	sessionInstanceId: true,
	operationId: true,
});
export type DiagnosticCaptureScope = z.infer<typeof diagnosticCaptureScopeSchema>;

export const diagnosticTruncationSummarySchema = z.object({
	strings: z.number().int().nonnegative().default(0),
	arrays: z.number().int().nonnegative().default(0),
	objects: z.number().int().nonnegative().default(0),
	depth: z.number().int().nonnegative().default(0),
	redacted: z.number().int().nonnegative().default(0),
	totalBytes: z.number().int().nonnegative().optional(),
});
export type DiagnosticTruncationSummary = z.infer<typeof diagnosticTruncationSummarySchema>;

export const diagnosticRecordEnvelopeSchema = z.object({
	version: z.literal(DIAGNOSTIC_SCHEMA_VERSION),
	id: z.string().min(1).max(256),
	sequence: z.number().int().nonnegative(),
	timestamp: z.number().int().nonnegative(),
	monotonicOffsetMs: z.number().nonnegative(),
	runtimeInstanceId: z.string().min(1).max(256),
	source: diagnosticSourceSchema,
	kind: diagnosticRecordKindSchema,
	level: diagnosticLevelSchema,
	name: z.string().min(1).max(256),
	context: diagnosticContextSchema,
	payload: z.unknown(),
	truncation: diagnosticTruncationSummarySchema.optional(),
});
export type DiagnosticRecordEnvelope = z.infer<typeof diagnosticRecordEnvelopeSchema>;

export const browserDiagnosticCandidateSchema = z.object({
	version: z.literal(DIAGNOSTIC_SCHEMA_VERSION),
	clientSequence: z.number().int().positive().safe(),
	timestamp: z.number().int().nonnegative().safe(),
	kind: z.enum(["event", "log", "mark"]),
	level: diagnosticLevelSchema,
	name: z.string().min(1).max(256),
	context: diagnosticContextSchema.default({}),
	payload: z.unknown(),
});
export type BrowserDiagnosticCandidate = z.infer<typeof browserDiagnosticCandidateSchema>;

export const diagnosticRecordingScopeSchema = z.object({
	projectId: z.string().min(1).max(256).optional(),
	taskId: z.string().min(1).max(256).optional(),
	categories: z.array(z.string().min(1).max(128)).max(50).default([]),
});
export type DiagnosticRecordingScope = z.infer<typeof diagnosticRecordingScopeSchema>;

export const diagnosticRecordingStateSchema = z.object({
	active: z.boolean(),
	startedAt: z.number().int().nonnegative().nullable(),
	expiresAt: z.number().int().nonnegative().nullable(),
	scope: diagnosticRecordingScopeSchema.nullable(),
});
export type DiagnosticRecordingState = z.infer<typeof diagnosticRecordingStateSchema>;

export const diagnosticRecorderHealthSchema = z.object({
	runtimeInstanceId: z.string().min(1),
	recordCount: z.number().int().nonnegative(),
	pendingJournalRecords: z.number().int().nonnegative(),
	droppedRecords: z.number().int().nonnegative(),
	rejectedBrowserRecords: z.number().int().nonnegative(),
	journalHealthy: z.boolean(),
	journalFailureCount: z.number().int().nonnegative(),
	lastJournalFlushAt: z.number().int().nonnegative().nullable(),
	recording: diagnosticRecordingStateSchema,
});
export type DiagnosticRecorderHealth = z.infer<typeof diagnosticRecorderHealthSchema>;

export const runtimeDiagnosticDescriptorStatusSchema = z.enum(["starting", "ready", "stopping", "stopped", "failed"]);
export type RuntimeDiagnosticDescriptorStatus = z.infer<typeof runtimeDiagnosticDescriptorStatusSchema>;

export const runtimeDiagnosticDescriptorSchema = z.object({
	version: z.literal(DIAGNOSTIC_SCHEMA_VERSION),
	runtimeInstanceId: z.string().min(1),
	status: runtimeDiagnosticDescriptorStatusSchema,
	pid: z.number().int().positive(),
	host: z.string().min(1),
	port: z.number().int().min(1).max(65_535),
	quarterdeckVersion: z.string().min(1),
	nodeMajorVersion: z.number().int().positive(),
	platform: z.enum(["mac", "linux", "windows", "other"]),
	startedAt: z.string().datetime(),
	readyAt: z.string().datetime().nullable(),
	stoppedAt: z.string().datetime().nullable(),
	diagnosticToken: z.string().min(32),
	journalDirectory: z.string().min(1),
	failure: z.string().nullable(),
});
export type RuntimeDiagnosticDescriptor = z.infer<typeof runtimeDiagnosticDescriptorSchema>;

export const publicRuntimeDiagnosticDescriptorSchema = runtimeDiagnosticDescriptorSchema.omit({
	diagnosticToken: true,
	journalDirectory: true,
});
export type PublicRuntimeDiagnosticDescriptor = z.infer<typeof publicRuntimeDiagnosticDescriptorSchema>;

export const diagnosticProviderStatusSchema = z.enum(["completed", "timed_out", "failed", "unavailable"]);
export type DiagnosticProviderStatus = z.infer<typeof diagnosticProviderStatusSchema>;

export const diagnosticProviderResultSchema = z.object({
	name: z.string().min(1).max(128),
	status: diagnosticProviderStatusSchema,
	durationMs: z.number().nonnegative(),
	data: z.unknown().optional(),
	error: z.string().max(2048).optional(),
});
export type DiagnosticProviderResult = z.infer<typeof diagnosticProviderResultSchema>;

export const diagnosticSnapshotSchema = z.object({
	version: z.literal(DIAGNOSTIC_SCHEMA_VERSION),
	runtimeInstanceId: z.string().min(1),
	capturedAt: z.number().int().nonnegative(),
	scope: diagnosticCaptureScopeSchema.optional(),
	providers: z.array(diagnosticProviderResultSchema),
});
export type DiagnosticSnapshot = z.infer<typeof diagnosticSnapshotSchema>;

export const diagnosticFindingSchema = z.object({
	code: z.string().min(1).max(128),
	severity: z.enum(["info", "warn", "error"]),
	summary: z.string().min(1).max(512),
	explanation: z.string().min(1).max(2048),
	context: diagnosticContextSchema,
	evidenceRecordIds: z.array(z.string().min(1).max(256)).max(100),
	observedAt: z.number().int().nonnegative(),
	limitations: z.array(z.string().max(512)).max(20).optional(),
});
export type DiagnosticFinding = z.infer<typeof diagnosticFindingSchema>;

export const diagnosticStatusSchema = z.object({
	descriptor: publicRuntimeDiagnosticDescriptorSchema,
	health: diagnosticRecorderHealthSchema,
});
export type DiagnosticStatus = z.infer<typeof diagnosticStatusSchema>;

export const browserDiagnosticSnapshotSchema = z.object({
	version: z.literal(DIAGNOSTIC_SCHEMA_VERSION),
	clientId: z.string().min(1).max(256),
	capturedAt: z.number().int().nonnegative(),
	route: z.string().max(256),
	visibility: z.enum(["visible", "hidden", "prerender", "unloaded", "unknown"]),
	viewport: z.object({
		width: z.number().int().nonnegative(),
		height: z.number().int().nonnegative(),
		devicePixelRatio: z.number().positive(),
	}),
	activeProjectId: z.string().max(256).nullable(),
	activeTaskId: z.string().max(256).nullable(),
	boardRevision: z.number().int().nonnegative().nullable(),
	runtimeStream: z.object({
		connected: z.boolean(),
	}),
	pendingProjectPersistence: z.boolean(),
	terminal: z.unknown(),
	layout: z.record(
		z.string(),
		z.object({
			x: z.number(),
			y: z.number(),
			width: z.number().nonnegative(),
			height: z.number().nonnegative(),
		}),
	),
});
export type BrowserDiagnosticSnapshot = z.infer<typeof browserDiagnosticSnapshotSchema>;

export const diagnosticBundleContentFlagsSchema = z.object({
	includePaths: z.boolean(),
	includeTaskText: z.boolean(),
	includeTerminal: z.boolean(),
	includeGitDiff: z.boolean(),
});
export type DiagnosticBundleContentFlags = z.infer<typeof diagnosticBundleContentFlagsSchema>;

export const diagnosticBundleManifestSchema = z.object({
	version: z.literal(DIAGNOSTIC_SCHEMA_VERSION),
	bundleId: z.string().min(1),
	quarterdeckVersion: z.string().min(1),
	runtimeInstanceId: z.string().min(1),
	createdAt: z.string().datetime(),
	tier: z.enum(["flight", "deep", "agent-lab"]),
	status: z.enum(["complete", "partial"]),
	timeRange: z.object({
		from: z.number().int().nonnegative().nullable(),
		to: z.number().int().nonnegative().nullable(),
	}),
	filters: z.object({
		projectId: z.string().nullable(),
		taskId: z.string().nullable(),
	}),
	redactionProfile: z.literal("quarterdeck-default-v1"),
	contentFlags: diagnosticBundleContentFlagsSchema,
	providerResults: z.array(diagnosticProviderResultSchema),
	recordCounts: z.record(z.string(), z.number().int().nonnegative()),
	findingCounts: z.record(z.string(), z.number().int().nonnegative()),
	warnings: z.array(z.string().max(2048)),
	files: z.array(
		z.object({
			path: z.string().min(1),
			size: z.number().int().nonnegative(),
			sha256: z.string().length(64),
		}),
	),
});
export type DiagnosticBundleManifest = z.infer<typeof diagnosticBundleManifestSchema>;
