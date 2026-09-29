import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { resolveAgentCommandForLaunch } from "../../config/agent-registry";
import { ConversationExportError, exportCodexConversation } from "../../conversation/codex-conversation-export";
import {
	type IRuntimeConfigProvider,
	type RuntimeTaskConversationResponse,
	runtimeTaskConversationRequestSchema,
} from "../../core";
import type { TerminalSessionManager } from "../../terminal";
import type { RuntimeTrpcProjectScope } from "../app-router-context";

interface ReadTaskConversationDependencies {
	config: Pick<IRuntimeConfigProvider, "loadScopedRuntimeConfig">;
	getScopedTerminalManager: (
		scope: RuntimeTrpcProjectScope,
	) => Promise<Pick<TerminalSessionManager, "store" | "getTaskSessionProcessIdentity">>;
	exportConversation?: typeof exportCodexConversation;
	resolveCommand?: typeof resolveAgentCommandForLaunch;
}

export async function handleReadTaskConversation(
	scope: RuntimeTrpcProjectScope,
	input: unknown,
	deps: ReadTaskConversationDependencies,
): Promise<RuntimeTaskConversationResponse> {
	try {
		const request = runtimeTaskConversationRequestSchema.parse(input);
		const manager = await deps.getScopedTerminalManager(scope);
		const summary = manager.store.getSummary(request.taskId);
		const identity = manager.getTaskSessionProcessIdentity(request.taskId);
		if (summary?.agentId !== "codex") {
			throw new ConversationExportError("Full conversation copying is available for Codex tasks.");
		}
		if (!summary.resumeSessionId) throw new ConversationExportError("No saved Codex conversation is available yet.");
		if (
			!identity?.binary ||
			identity.agentId !== "codex" ||
			identity.sessionInstanceId !== request.sessionInstanceId ||
			summary.sessionInstanceId !== request.sessionInstanceId
		) {
			throw new ConversationExportError("The Codex session is no longer connected. Open the task and try again.");
		}
		const config = await deps.config.loadScopedRuntimeConfig(scope);
		const command = await (deps.resolveCommand ?? resolveAgentCommandForLaunch)({
			...config,
			selectedAgentId: "codex",
		});
		if (command.binary !== identity.binary)
			throw new ConversationExportError("The Codex executable changed. Restart the task before copying.");
		const profile = identity.profileEnvironment;
		const codexHome = resolve(
			summary.sessionLaunchPath ?? scope.projectPath,
			profile.CODEX_HOME?.trim() || join(profile.HOME || homedir(), ".codex"),
		);
		const text = await (deps.exportConversation ?? exportCodexConversation)({
			binary: identity.binary,
			args: command.args,
			cwd: scope.projectPath,
			env: { ...process.env, ...profile },
			codexHome,
			threadId: summary.resumeSessionId,
		});
		const current = manager.store.getSummary(request.taskId);
		const currentProcess = manager.getTaskSessionProcessIdentity(request.taskId);
		if (
			current?.resumeSessionId !== summary.resumeSessionId ||
			current.sessionInstanceId !== request.sessionInstanceId ||
			currentProcess?.sessionInstanceId !== request.sessionInstanceId ||
			currentProcess.pid !== identity.pid
		) {
			throw new ConversationExportError("The Codex conversation changed while copying. Try again.");
		}
		return { ok: true, text };
	} catch (error) {
		return {
			ok: false,
			error:
				error instanceof ConversationExportError
					? error.message
					: "Could not read the full Codex conversation. Try again.",
		};
	}
}
