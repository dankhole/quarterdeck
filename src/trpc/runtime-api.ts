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
import type { ProjectTaskLifecycleService } from "../server/project-task-lifecycle-service";
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
	taskLifecycle?: Pick<ProjectTaskLifecycleService, "execute" | "getOperation">;
}

type RuntimeApi = RuntimeTrpcContext["runtimeApi"];

class RuntimeApiImpl implements RuntimeApi {
	constructor(private readonly deps: CreateRuntimeApiDependencies) {}

	// ── Config ────────────────────────────────────────────────────────────

	async loadConfig(projectScope: RuntimeTrpcProjectScope | null) {
		return handleLoadConfig(projectScope, {
			config: this.deps.config,
			runtimeCapabilities: this.deps.hostIntegrations.capabilities,
		});
	}

	async saveConfig(projectScope: RuntimeTrpcProjectScope | null, input: unknown) {
		return handleSaveConfig(projectScope, input, {
			config: this.deps.config,
			broadcaster: this.deps.broadcaster,
			getActiveProjectId: this.deps.getActiveProjectId,
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

	async executeTaskLifecycle(
		projectScope: RuntimeTrpcProjectScope,
		input: Parameters<ProjectTaskLifecycleService["execute"]>[1],
	) {
		if (!this.deps.taskLifecycle) {
			throw new Error("Task lifecycle service is not configured.");
		}
		return await this.deps.taskLifecycle.execute(projectScope, input);
	}

	async getTaskLifecycleOperation(projectScope: RuntimeTrpcProjectScope, operationId: string) {
		if (!this.deps.taskLifecycle) {
			throw new Error("Task lifecycle service is not configured.");
		}
		return await this.deps.taskLifecycle.getOperation(projectScope, operationId);
	}

	async sendTaskSessionInput(projectScope: RuntimeTrpcProjectScope, input: unknown) {
		return handleSendTaskSessionInput(projectScope, input, this.deps);
	}

	// ── Shell ─────────────────────────────────────────────────────────────

	async startShellSession(projectScope: RuntimeTrpcProjectScope, input: unknown) {
		return handleStartShellSession(projectScope, input, this.deps);
	}

	async openProject(projectScope: RuntimeTrpcProjectScope, input: unknown) {
		return handleOpenProject(projectScope, input, { hostIntegrations: this.deps.hostIntegrations });
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
