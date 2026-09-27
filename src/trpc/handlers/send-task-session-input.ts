import {
	canSendTaskQuickReply,
	parseTaskSessionInputRequest,
	TASK_QUICK_REPLY_MAX_LENGTH,
	type TaskResourceOperationRunner,
} from "../../core";
import type { TerminalSessionManager } from "../../terminal";
import { prepareTerminalImagePaste } from "../../terminal/terminal-image-paste";
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
			const terminalManager = await deps.getScopedTerminalManager(projectScope);
			if ("images" in body) {
				const identity = terminalManager.getTaskSessionProcessIdentity(body.taskId);
				if (!identity?.agentId || identity.sessionInstanceId !== body.sessionInstanceId) {
					throw new Error("Task session changed before image paste.");
				}
				const prepared = await prepareTerminalImagePaste(body.images);
				let delivered = false;
				try {
					await deps.assertNativeInputAllowed?.(projectScope, body.taskId);
					const current = terminalManager.getTaskSessionProcessIdentity(body.taskId);
					if (current?.sessionInstanceId !== identity.sessionInstanceId || current.pid !== identity.pid) {
						throw new Error("Task session changed during image paste.");
					}
					const result = terminalManager.writeInput(body.taskId, prepared.data, { explicitUserSubmission: false });
					delivered = result !== null;
					return result;
				} finally {
					if (!delivered) await prepared.discard();
				}
			}
			let payloadText = body.appendNewline ? `${body.text}${getTerminalSubmitTerminator()}` : body.text;
			if (body.replyToSessionInstanceId) {
				const current = terminalManager.store.getSummary(body.taskId);
				const identity = terminalManager.getTaskSessionProcessIdentity(body.taskId);
				if (
					!canSendTaskQuickReply(current) ||
					current?.sessionInstanceId !== body.replyToSessionInstanceId ||
					identity?.sessionInstanceId !== body.replyToSessionInstanceId
				) {
					throw new Error(
						"The agent is no longer ready for this reply. Your draft is saved; open the agent to continue.",
					);
				}
				// biome-ignore lint/suspicious/noControlCharactersInRegex: Reject terminal control bytes in board replies.
				const hasTerminalControls = /[\u0000-\u0008\u000b-\u001f\u007f]/u.test(body.text);
				if (
					body.intent !== "submit" ||
					!body.text.trim() ||
					body.text.length > TASK_QUICK_REPLY_MAX_LENGTH ||
					hasTerminalControls
				) {
					throw new Error("Enter a reply of up to 8,000 characters without terminal control characters.");
				}
				// Native TUIs accept bracketed paste; multiline text must never become separate submissions.
				payloadText = `\x1b[200~${body.text}\x1b[201~\r`;
			}
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
