import { z } from "zod";

export const AGENT_LAB_SCHEMA_VERSION = 4;

export const AgentLabAgentModeSchema = z.enum(["fake", "real-codex"]);

export type AgentLabAgentMode = z.infer<typeof AgentLabAgentModeSchema>;

export const AgentLabCodexSandboxSchema = z.enum(["read-only", "workspace-write"]);

export type AgentLabCodexSandbox = z.infer<typeof AgentLabCodexSandboxSchema>;

export const AgentLabCodexApprovalPolicySchema = z.enum(["on-request", "never"]);

export type AgentLabCodexApprovalPolicy = z.infer<typeof AgentLabCodexApprovalPolicySchema>;

const AgentLabModelSchema = z
	.string()
	.min(1)
	.max(200)
	.regex(
		/^[A-Za-z0-9][A-Za-z0-9._:/-]*$/,
		"Model IDs may contain only letters, numbers, '.', '_', ':', '/', and '-'.",
	);

const AgentLabPublicAgentConfigSchema = z.discriminatedUnion("mode", [
	z.object({ mode: z.literal("fake") }),
	z.object({
		mode: z.literal("real-codex"),
		model: AgentLabModelSchema,
		modelProvider: z.literal("openai"),
		reasoningEffort: z.literal("low"),
		authentication: z.literal("existing-cli"),
		profileSource: z.enum(["explicit", "environment", "default"]),
		sandbox: AgentLabCodexSandboxSchema,
		approvalPolicy: AgentLabCodexApprovalPolicySchema,
		serviceTier: z.literal("default"),
		historyPersistence: z.literal("none"),
		webSearch: z.literal("disabled"),
		externalIntegrations: z.literal("disabled"),
		profileHooks: z.enum(["replaced", "isolated"]),
		telemetry: z.literal("disabled"),
	}),
]);

export type AgentLabPublicAgentConfig = z.infer<typeof AgentLabPublicAgentConfigSchema>;

export const AgentLabLaunchAgentConfigSchema = z.discriminatedUnion("mode", [
	z.object({ mode: z.literal("fake") }),
	z.object({
		mode: z.literal("real-codex"),
		model: AgentLabModelSchema,
		modelProvider: z.literal("openai"),
		reasoningEffort: z.literal("low"),
		authentication: z.literal("existing-cli"),
		profileSource: z.enum(["explicit", "environment", "default"]),
		sandbox: AgentLabCodexSandboxSchema,
		approvalPolicy: AgentLabCodexApprovalPolicySchema,
		serviceTier: z.literal("default"),
		historyPersistence: z.literal("none"),
		webSearch: z.literal("disabled"),
		externalIntegrations: z.literal("disabled"),
		profileHooks: z.literal("isolated"),
		telemetry: z.literal("disabled"),
		codexHomePath: z.string().min(1),
	}),
]);

export type AgentLabLaunchAgentConfig = z.infer<typeof AgentLabLaunchAgentConfigSchema>;

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

export const AgentLabManifestV3Schema = AgentLabManifestV2Schema.omit({ schemaVersion: true }).extend({
	schemaVersion: z.literal(3),
	runtimeRestartRequestPath: z.string().min(1),
	runtimeRestartResultPath: z.string().min(1),
	runtimeGeneration: z.number().int().positive(),
	runtimeRestarts: z.array(AgentLabRuntimeRestartRecordSchema),
});
export type AgentLabManifestV3 = z.infer<typeof AgentLabManifestV3Schema>;

export const AgentLabManifestSchema = AgentLabManifestV3Schema.omit({ schemaVersion: true }).extend({
	schemaVersion: z.literal(AGENT_LAB_SCHEMA_VERSION),
	agent: AgentLabPublicAgentConfigSchema,
});

export type AgentLabManifest = z.infer<typeof AgentLabManifestSchema>;

export const ReadableAgentLabManifestSchema = z.discriminatedUnion("schemaVersion", [
	AgentLabManifestV1Schema,
	AgentLabManifestV2Schema,
	AgentLabManifestV3Schema,
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
	agent: AgentLabLaunchAgentConfigSchema,
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
