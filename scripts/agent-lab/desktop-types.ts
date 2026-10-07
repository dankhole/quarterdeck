import { z } from "zod";
import type { AgentLabPublicAgentConfig } from "./types";

export const DesktopAgentModeSchema = z.enum(["fake", "real-codex", "real-claude"]);
export type DesktopAgentMode = z.infer<typeof DesktopAgentModeSchema>;

export const DesktopLabConfigSchema = z
	.object({
		version: z.literal(1),
		tempRoot: z.string().min(1),
		stateHome: z.string().min(1),
		userDataPath: z.string().min(1),
		projectPath: z.string().min(1),
		hostSimulationConfigPath: z.string().min(1),
		processEvidencePath: z.string().min(1),
		showWindow: z.boolean().optional(),
	})
	.strict();

export type DesktopLabConfig = z.infer<typeof DesktopLabConfigSchema>;

export const DesktopProcessEvidenceSchema = z
	.object({
		version: z.literal(1),
		appPid: z.number().int().positive().optional(),
		helperPid: z.number().int().positive().nullable(),
		generation: z.string().min(1).nullable(),
		runtimeOrigin: z.string().nullable(),
		phase: z.enum(["starting", "ready", "stopping", "stopped", "failed"]),
	})
	.strict();

export type DesktopProcessEvidence = z.infer<typeof DesktopProcessEvidenceSchema>;

export interface DesktopLabProcess {
	pid: number;
	parentPid: number;
	startedAt: string;
	command: string;
}

export interface DesktopLabShutdownEvidence {
	gracefulQuit: {
		attempted: boolean;
		outcome: "not_attempted" | "sdk_close_completed" | "unconfirmed";
	};
	/** Null means process inspection could not confirm the pre-fallback forest. */
	remainingBeforeFallback: DesktopLabProcess[] | null;
	fallbackUsed: boolean;
}

export interface DesktopLabManifest {
	schemaVersion: 1;
	surface: "electron";
	runId: string;
	status: "starting" | "ready" | "stopping" | "stopped" | "failed";
	appPath: string;
	executablePath: string;
	artifactDir: string;
	tempRoot: string;
	userDataPath: string;
	stateHome: string;
	projectPath: string;
	showWindow: boolean;
	agent: AgentLabPublicAgentConfig;
	providerVersion: string | null;
	mainPid: number | null;
	helperPid: number | null;
	rendererPids: number[];
	processes: DesktopLabProcess[];
	remainingPids: number[];
	shutdown?: DesktopLabShutdownEvidence;
	createdAt: string;
	stoppedAt: string | null;
	failure: string | null;
}
