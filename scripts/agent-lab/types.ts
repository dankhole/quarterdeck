import { z } from "zod";

export const AGENT_LAB_SCHEMA_VERSION = 1;

export const AgentLabScenarioSchema = z.enum([
	"idle",
	"needs-input",
	"review",
	"failure",
	"git-dirty",
	"terminal-stress",
]);

export type AgentLabScenario = z.infer<typeof AgentLabScenarioSchema>;

export const AgentLabStatusSchema = z.enum(["starting", "ready", "stopping", "stopped", "failed"]);

export type AgentLabStatus = z.infer<typeof AgentLabStatusSchema>;

const AgentLabProcessSchema = z.object({
	pid: z.number().int().positive(),
	logPath: z.string().min(1),
});

export const AgentLabManifestSchema = z.object({
	schemaVersion: z.literal(AGENT_LAB_SCHEMA_VERSION),
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
	runtimeCapabilities: z.object({ nativeUiAvailable: z.literal(false) }),
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

export type AgentLabManifest = z.infer<typeof AgentLabManifestSchema>;

export const AgentLabLaunchConfigSchema = z.object({
	schemaVersion: z.literal(AGENT_LAB_SCHEMA_VERSION),
	runId: z.string().min(1),
	repoRoot: z.string().min(1),
	artifactDir: z.string().min(1),
	manifestPath: z.string().min(1),
	stopRequestPath: z.string().min(1),
	tempRoot: z.string().min(1),
	keepTemp: z.boolean(),
	scenario: AgentLabScenarioSchema,
	runtimePort: z.number().int().min(0).max(65_535).nullable(),
	webPort: z.number().int().min(0).max(65_535).nullable(),
	forwardLogs: z.boolean(),
	runtimeCapabilities: z.object({ nativeUiAvailable: z.literal(false) }),
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
