// Coordinates the runtime-side TRPC handlers used by the browser.
// Each handler is a standalone function in src/trpc/handlers/. This class
// is a thin dispatcher that delegates to them, providing the shared
// dependency bag each handler needs.

import type { IRuntimeBroadcaster, IRuntimeConfigProvider, RuntimeCommandRunResponse } from "../core";
import type { TerminalSessionManager } from "../terminal";
import type { RuntimeTrpcContext, RuntimeTrpcWorkspaceScope } from "./app-router-context";
import { handleFlagTaskForDebug } from "./handlers/flag-task-for-debug";
import { handleLoadConfig } from "./handlers/load-config";
import { handleMigrateTaskWorkingDirectory } from "./handlers/migrate-task-working-directory";
import { handleOpenFile } from "./handlers/open-file";
import { handleRunCommand } from "./handlers/run-command";
import { handleSaveConfig } from "./handlers/save-config";
import { handleSendTaskSessionInput } from "./handlers/send-task-session-input";
import { handleSetLogLevel } from "./handlers/set-log-level";
import { handleStartShellSession } from "./handlers/start-shell-session";
import { handleStartTaskSession } from "./handlers/start-task-session";
import { handleStopTaskSession } from "./handlers/stop-task-session";

export interface CreateRuntimeApiDependencies {
	config: IRuntimeConfigProvider;
	broadcaster: Pick<
		IRuntimeBroadcaster,
		| "broadcastRuntimeWorkspaceStateUpdated"
		| "broadcastTaskWorkingDirectoryUpdated"
		| "setPollIntervals"
		| "broadcastLogLevel"
	>;
	getActiveWorkspaceId: () => string | null;
	getScopedTerminalManager: (scope: RuntimeTrpcWorkspaceScope) => Promise<TerminalSessionManager>;
	resolveInteractiveShellCommand: () => { binary: string; args: string[] };
	runCommand: (command: string, cwd: string) => Promise<RuntimeCommandRunResponse>;
}

type RuntimeApi = RuntimeTrpcContext["runtimeApi"];

class RuntimeApiImpl implements RuntimeApi {
	constructor(private readonly deps: CreateRuntimeApiDependencies) {}

	// ── Config ────────────────────────────────────────────────────────────

	async loadConfig(workspaceScope: RuntimeTrpcWorkspaceScope | null) {
		return handleLoadConfig(workspaceScope, this.deps);
	}

	async saveConfig(workspaceScope: RuntimeTrpcWorkspaceScope | null, input: unknown) {
		return handleSaveConfig(workspaceScope, input, this.deps);
	}

	// ── Sessions ──────────────────────────────────────────────────────────

	async startTaskSession(workspaceScope: RuntimeTrpcWorkspaceScope, input: unknown) {
		return handleStartTaskSession(workspaceScope, input, this.deps);
	}

	async stopTaskSession(workspaceScope: RuntimeTrpcWorkspaceScope, input: unknown) {
		return handleStopTaskSession(workspaceScope, input, this.deps);
	}

	async sendTaskSessionInput(workspaceScope: RuntimeTrpcWorkspaceScope, input: unknown) {
		return handleSendTaskSessionInput(workspaceScope, input, this.deps);
	}

	// ── Shell ─────────────────────────────────────────────────────────────

	async startShellSession(workspaceScope: RuntimeTrpcWorkspaceScope, input: unknown) {
		return handleStartShellSession(workspaceScope, input, this.deps);
	}

	async runCommand(workspaceScope: RuntimeTrpcWorkspaceScope, input: unknown) {
		return handleRunCommand(workspaceScope, input, this.deps);
	}

	// ── Debug / utility ───────────────────────────────────────────────────

	setLogLevel(level: "debug" | "info" | "warn" | "error") {
		return handleSetLogLevel(level, this.deps);
	}

	async flagTaskForDebug(workspaceScope: RuntimeTrpcWorkspaceScope, input: { taskId: string; note?: string }) {
		return handleFlagTaskForDebug(workspaceScope, input, this.deps);
	}

	async openFile(input: { filePath: string }) {
		return handleOpenFile(input);
	}

	// ── Migration ─────────────────────────────────────────────────────────

	async migrateTaskWorkingDirectory(
		workspaceScope: RuntimeTrpcWorkspaceScope,
		input: { taskId: string; direction: "isolate" | "de-isolate" },
	) {
		return handleMigrateTaskWorkingDirectory(workspaceScope, input, this.deps);
	}
}

export function createRuntimeApi(deps: CreateRuntimeApiDependencies): RuntimeTrpcContext["runtimeApi"] {
	return new RuntimeApiImpl(deps);
}
