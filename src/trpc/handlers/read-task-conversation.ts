import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { resolveAgentCommandForLaunch } from "../../config/agent-registry";
import { exportClaudeConversation, resolveClaudeTaskProfileRoot } from "../../conversation/claude-conversation-export";
import { ConversationExportError, exportCodexConversation } from "../../conversation/codex-conversation-export";
import type { ConversationSourceHintReader } from "../../conversation/types";
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
	conversationSourceHints?: ConversationSourceHintReader;
	exportConversation?: typeof exportCodexConversation;
	exportClaudeConversation?: typeof exportClaudeConversation;
	resolveCommand?: typeof resolveAgentCommandForLaunch;
}

const PROVIDER_LABELS = { claude: "Claude", codex: "Codex" } as const;
type ExportableAgentId = keyof typeof PROVIDER_LABELS;

function isExportableAgent(agentId: string | null | undefined): agentId is ExportableAgentId {
	return agentId === "claude" || agentId === "codex";
}

export async function handleReadTaskConversation(
	scope: RuntimeTrpcProjectScope,
	input: unknown,
	deps: ReadTaskConversationDependencies,
): Promise<RuntimeTaskConversationResponse> {
	let label = "";
	try {
		const request = runtimeTaskConversationRequestSchema.parse(input);
		const manager = await deps.getScopedTerminalManager(scope);
		const summary = manager.store.getSummary(request.taskId);
		const identity = manager.getTaskSessionProcessIdentity(request.taskId);
		const agentId = summary?.agentId;
		if (!summary || !isExportableAgent(agentId)) {
			throw new ConversationExportError("Full conversation copying is available for Claude and Codex tasks.");
		}
		label = PROVIDER_LABELS[agentId];
		if (!summary.resumeSessionId)
			throw new ConversationExportError(`No saved ${label} conversation is available yet.`);
		if (
			!identity?.binary ||
			identity.agentId !== agentId ||
			identity.sessionInstanceId !== request.sessionInstanceId ||
			summary.sessionInstanceId !== request.sessionInstanceId
		) {
			throw new ConversationExportError(`The ${label} session is no longer connected. Open the task and try again.`);
		}
		const profile = identity.profileEnvironment;
		const launchPath = summary.sessionLaunchPath ?? scope.projectPath;
		let text: string;
		if (agentId === "claude") {
			// Persisted JSONL only: no executable is launched, so no command identity check applies.
			text = await (deps.exportClaudeConversation ?? exportClaudeConversation)({
				profileRoot: resolveClaudeTaskProfileRoot(launchPath, profile),
				sessionId: summary.resumeSessionId,
				hint:
					deps.conversationSourceHints?.getHint(scope.projectId, request.taskId, summary.resumeSessionId) ?? null,
			});
		} else {
			const config = await deps.config.loadScopedRuntimeConfig(scope);
			const command = await (deps.resolveCommand ?? resolveAgentCommandForLaunch)({
				...config,
				selectedAgentId: "codex",
			});
			if (command.binary !== identity.binary)
				throw new ConversationExportError("The Codex executable changed. Restart the task before copying.");
			const codexHome = resolve(launchPath, profile.CODEX_HOME?.trim() || join(profile.HOME || homedir(), ".codex"));
			text = await (deps.exportConversation ?? exportCodexConversation)({
				binary: identity.binary,
				args: command.args,
				cwd: scope.projectPath,
				env: { ...process.env, ...profile },
				codexHome,
				threadId: summary.resumeSessionId,
			});
		}
		const current = manager.store.getSummary(request.taskId);
		const currentProcess = manager.getTaskSessionProcessIdentity(request.taskId);
		if (
			current?.resumeSessionId !== summary.resumeSessionId ||
			current.sessionInstanceId !== request.sessionInstanceId ||
			currentProcess?.sessionInstanceId !== request.sessionInstanceId ||
			currentProcess.pid !== identity.pid
		) {
			throw new ConversationExportError(`The ${label} conversation changed while copying. Try again.`);
		}
		return { ok: true, text };
	} catch (error) {
		return {
			ok: false,
			error:
				error instanceof ConversationExportError
					? error.message
					: `Could not read the full ${label ? `${label} ` : ""}conversation. Try again.`,
		};
	}
}
