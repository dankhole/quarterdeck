import { z } from "zod";

export const AGENT_LAB_SCHEMA_VERSION = 3;

export const AgentLabScenarioSchema = z.enum([
	"idle",
	"needs-input",
	"review",
	"failure",
	"git-dirty",
	"terminal-stress",
]);

export type AgentLabScenario = z.infer<typeof AgentLabScenarioSchema>;

export const AgentLabStatusSchema = z.enum(["starting", "ready", "restarting", "stopping", "stopped", "failed"]);

export type AgentLabStatus = z.infer<typeof AgentLabStatusSchema>;

const AgentLabProcessSchema = z.object({
	pid: z.number().int().positive(),
	logPath: z.string().min(1),
});

export const AgentLabRuntimeRestartRequestSchema = z.object({
	schemaVersion: z.literal(1),
	requestId: z.string().uuid(),
	mode: z.literal("graceful"),
	requestedAt: z.string().datetime(),
	requestedBy: z.number().int().positive(),
});
export type AgentLabRuntimeRestartRequest = z.infer<typeof AgentLabRuntimeRestartRequestSchema>;

const AgentLabRuntimeRestartRecordSchema = z.object({
	requestId: z.string().uuid(),
	mode: z.literal("graceful"),
	status: z.enum(["pending", "completed", "failed"]),
	fromGeneration: z.number().int().positive(),
	toGeneration: z.number().int().positive().nullable(),
	requestedAt: z.string().datetime(),
	completedAt: z.string().datetime().nullable(),
	previousProcess: AgentLabProcessSchema,
	replacementProcess: AgentLabProcessSchema.nullable(),
	error: z.string().nullable(),
});
export type AgentLabRuntimeRestartRecord = z.infer<typeof AgentLabRuntimeRestartRecordSchema>;

export const AgentLabRuntimeRestartResultSchema = AgentLabRuntimeRestartRecordSchema.extend({
	schemaVersion: z.literal(1),
});
export type AgentLabRuntimeRestartResult = z.infer<typeof AgentLabRuntimeRestartResultSchema>;

const AgentLabManifestBaseSchema = z.object({
	runId: z.string().min(1),
	status: AgentLabStatusSchema,
	repoRoot: z.string().min(1),
	artifactDir: z.string().min(1),
	manifestPath: z.string().min(1),
	stopRequestPath: z.string().min(1),
	tempRoot: z.string().min(1),
	homePath: z.string().min(1),
	statePath: z.string().min(1),
	projectPath: z.string().min(1),
	additionalProjectPath: z.string().min(1),
	forbiddenHostLaunchLogPath: z.string().min(1),
	projectUrl: z.string().url(),
	runtimeUrl: z.string().url(),
	webUrl: z.string().url(),
	browserConfigPath: z.string().min(1),
	browserOutputPath: z.string().min(1),
	browserSession: z.string().min(1),
	scenario: AgentLabScenarioSchema,
	keepTemp: z.boolean(),
	supervisorPid: z.number().int().positive(),
	processes: z.object({
		runtime: AgentLabProcessSchema.nullable(),
		web: AgentLabProcessSchema.nullable(),
	}),
	createdAt: z.string().datetime(),
	readyAt: z.string().datetime().nullable(),
	stoppedAt: z.string().datetime().nullable(),
	failure: z.string().nullable(),
});

export const AgentLabManifestV1Schema = AgentLabManifestBaseSchema.extend({
	schemaVersion: z.literal(1),
	runtimeCapabilities: z.object({ nativeUiAvailable: z.literal(false) }),
});
export type AgentLabManifestV1 = z.infer<typeof AgentLabManifestV1Schema>;

export const AgentLabManifestV2Schema = AgentLabManifestBaseSchema.extend({
	schemaVersion: z.literal(2),
	hostEventLedgerPath: z.string().min(1),
	runtimeCapabilities: z.object({
		nativeUiAvailable: z.literal(false),
		hostIntegrationMode: z.literal("simulated"),
	}),
});
export type AgentLabManifestV2 = z.infer<typeof AgentLabManifestV2Schema>;

export const AgentLabManifestSchema = AgentLabManifestV2Schema.omit({ schemaVersion: true }).extend({
	schemaVersion: z.literal(AGENT_LAB_SCHEMA_VERSION),
	runtimeRestartRequestPath: z.string().min(1),
	runtimeRestartResultPath: z.string().min(1),
	runtimeGeneration: z.number().int().positive(),
	runtimeRestarts: z.array(AgentLabRuntimeRestartRecordSchema),
});

export type AgentLabManifest = z.infer<typeof AgentLabManifestSchema>;

export const ReadableAgentLabManifestSchema = z.discriminatedUnion("schemaVersion", [
	AgentLabManifestV1Schema,
	AgentLabManifestV2Schema,
	AgentLabManifestSchema,
]);
export type ReadableAgentLabManifest = z.infer<typeof ReadableAgentLabManifestSchema>;

export const AgentLabLaunchConfigSchema = z.object({
	schemaVersion: z.literal(AGENT_LAB_SCHEMA_VERSION),
	runId: z.string().min(1),
	repoRoot: z.string().min(1),
	artifactDir: z.string().min(1),
	manifestPath: z.string().min(1),
	stopRequestPath: z.string().min(1),
	runtimeRestartRequestPath: z.string().min(1),
	runtimeRestartResultPath: z.string().min(1),
	tempRoot: z.string().min(1),
	keepTemp: z.boolean(),
	scenario: AgentLabScenarioSchema,
	runtimePort: z.number().int().min(0).max(65_535).nullable(),
	webPort: z.number().int().min(0).max(65_535).nullable(),
	forwardLogs: z.boolean(),
	runtimeCapabilities: z.object({
		nativeUiAvailable: z.literal(false),
		hostIntegrationMode: z.literal("simulated"),
	}),
});

export type AgentLabLaunchConfig = z.infer<typeof AgentLabLaunchConfigSchema>;

export interface AgentLabSnapshotResult {
	label: string;
	path: string;
	createdAt: string;
	bundleId: string;
	status: "complete" | "partial";
	warnings: string[];
}
