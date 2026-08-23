// Coordinates the runtime-side TRPC handlers used by the browser.
// Each handler is a standalone function in src/trpc/handlers/. This class
// is a thin dispatcher that delegates to them, providing the shared
// dependency bag each handler needs.

import type {
	IRuntimeBroadcaster,
	IRuntimeConfigProvider,
	IRuntimeHostIntegrations,
	TaskResourceOperationRunner,
} from "../core";
import type { TerminalSessionManager } from "../terminal";
import type { RuntimeTrpcContext, RuntimeTrpcProjectScope } from "./app-router-context";
import { handleLoadConfig } from "./handlers/load-config";
import { handleOpenFile } from "./handlers/open-file";
import { handleOpenProject } from "./handlers/open-project";
import { handleSaveConfig } from "./handlers/save-config";
import { handleSendTaskSessionInput } from "./handlers/send-task-session-input";
import { handleSetLogLevel } from "./handlers/set-log-level";
import { handleStartShellSession } from "./handlers/start-shell-session";
import { handleStartTaskSession } from "./handlers/start-task-session";
import { handleStopTaskSession } from "./handlers/stop-task-session";

export interface CreateRuntimeApiDependencies {
	config: IRuntimeConfigProvider;
	broadcaster: Pick<IRuntimeBroadcaster, "broadcastRuntimeProjectStateUpdated" | "broadcastLogLevel">;
	getActiveProjectId: () => string | null;
	getScopedTerminalManager: (scope: RuntimeTrpcProjectScope) => Promise<TerminalSessionManager>;
	taskResourceOperations: TaskResourceOperationRunner;
	resolveInteractiveShellCommand: () => { binary: string; args: string[] };
	hostIntegrations: IRuntimeHostIntegrations;
}

type RuntimeApi = RuntimeTrpcContext["runtimeApi"];

class RuntimeApiImpl implements RuntimeApi {
	constructor(private readonly deps: CreateRuntimeApiDependencies) {}

	// ── Config ────────────────────────────────────────────────────────────

	async loadConfig(projectScope: RuntimeTrpcProjectScope | null) {
		return handleLoadConfig(projectScope, {
			...this.deps,
			runtimeCapabilities: this.deps.hostIntegrations.capabilities,
		});
	}

	async saveConfig(projectScope: RuntimeTrpcProjectScope | null, input: unknown) {
		return handleSaveConfig(projectScope, input, {
			...this.deps,
			runtimeCapabilities: this.deps.hostIntegrations.capabilities,
		});
	}

	// ── Sessions ──────────────────────────────────────────────────────────

	async startTaskSession(projectScope: RuntimeTrpcProjectScope, input: unknown) {
		return handleStartTaskSession(projectScope, input, this.deps);
	}

	async stopTaskSession(projectScope: RuntimeTrpcProjectScope, input: unknown) {
		return handleStopTaskSession(projectScope, input, this.deps);
	}

	async sendTaskSessionInput(projectScope: RuntimeTrpcProjectScope, input: unknown) {
		return handleSendTaskSessionInput(projectScope, input, this.deps);
	}

	// ── Shell ─────────────────────────────────────────────────────────────

	async startShellSession(projectScope: RuntimeTrpcProjectScope, input: unknown) {
		return handleStartShellSession(projectScope, input, this.deps);
	}

	async openProject(projectScope: RuntimeTrpcProjectScope, input: unknown) {
		return handleOpenProject(projectScope, input, this.deps);
	}

	// ── Debug / utility ───────────────────────────────────────────────────

	async setLogLevel(level: "debug" | "info" | "warn" | "error") {
		return await handleSetLogLevel(level, this.deps);
	}

	async openFile(projectScope: RuntimeTrpcProjectScope | null, input: { filePath: string }) {
		return handleOpenFile(projectScope, input, this.deps);
	}
}

export function createRuntimeApi(deps: CreateRuntimeApiDependencies): RuntimeTrpcContext["runtimeApi"] {
	return new RuntimeApiImpl(deps);
}
