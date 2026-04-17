import { parseTaskSessionInputRequest } from "../../core";
import type { TerminalSessionManager } from "../../terminal";
import type { RuntimeTrpcWorkspaceScope } from "../app-router-context";

export interface SendTaskSessionInputDeps {
	getScopedTerminalManager: (scope: RuntimeTrpcWorkspaceScope) => Promise<TerminalSessionManager>;
}

export async function handleSendTaskSessionInput(
	workspaceScope: RuntimeTrpcWorkspaceScope,
	input: unknown,
	deps: SendTaskSessionInputDeps,
) {
	try {
		const body = parseTaskSessionInputRequest(input);
		const payloadText = body.appendNewline ? `${body.text}\n` : body.text;
		const terminalManager = await deps.getScopedTerminalManager(workspaceScope);
		const summary = terminalManager.writeInput(body.taskId, Buffer.from(payloadText, "utf8"));
		if (!summary) {
			return {
				ok: false,
				summary: null,
				error: "Task session is not running.",
			};
		}
		return {
			ok: true,
			summary,
		};
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		return {
			ok: false,
			summary: null,
			error: message,
		};
	}
}
