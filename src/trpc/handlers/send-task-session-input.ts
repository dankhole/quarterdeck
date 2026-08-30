import { parseTaskSessionInputRequest, type TaskResourceOperationRunner } from "../../core";
import type { TerminalSessionManager } from "../../terminal";
import type { RuntimeTrpcProjectScope } from "../app-router-context";

export interface SendTaskSessionInputDeps {
	getScopedTerminalManager: (scope: RuntimeTrpcProjectScope) => Promise<TerminalSessionManager>;
	taskResourceOperations: TaskResourceOperationRunner;
	assertNativeInputAllowed?: (scope: RuntimeTrpcProjectScope, taskId: string) => Promise<void>;
}

function getTerminalSubmitTerminator(): "\r" | "\n" {
	return process.platform === "win32" ? "\r" : "\n";
}

export async function handleSendTaskSessionInput(
	projectScope: RuntimeTrpcProjectScope,
	input: unknown,
	deps: SendTaskSessionInputDeps,
) {
	try {
		const body = parseTaskSessionInputRequest(input);
		const summary = await deps.taskResourceOperations.run(projectScope.projectId, body.taskId, async () => {
			await deps.assertNativeInputAllowed?.(projectScope, body.taskId);
			const payloadText = body.appendNewline ? `${body.text}${getTerminalSubmitTerminator()}` : body.text;
			const terminalManager = await deps.getScopedTerminalManager(projectScope);
			return terminalManager.writeInput(body.taskId, Buffer.from(payloadText, "utf8"), {
				explicitUserSubmission: body.intent === "submit",
			});
		});
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
