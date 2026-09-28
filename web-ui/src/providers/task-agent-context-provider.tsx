import { canSendTaskQuickReply, TASK_QUICK_REPLY_MAX_LENGTH } from "@runtime-contract";
import {
	createContext,
	type ReactNode,
	useCallback,
	useContext,
	useLayoutEffect,
	useMemo,
	useRef,
	useState,
} from "react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogBody, DialogDescription, DialogFooter, DialogHeader } from "@/components/ui/dialog";
import { type AgentPromptContext, buildAgentContextPrompt } from "@/hooks/git/agent-context";
import type { RuntimeTaskSessionSummary } from "@/runtime/types";
import type { SendTerminalInputOptions } from "@/terminal/terminal-input";

export interface TaskAgentContextValue {
	openContext: (context: AgentPromptContext) => void;
}

const TaskAgentContext = createContext<TaskAgentContextValue | null>(null);

export function useTaskAgentContext(): TaskAgentContextValue | null {
	return useContext(TaskAgentContext);
}

interface ContextDraft {
	context: AgentPromptContext;
	scopeKey: string;
	sessionInstanceId: string | null;
	source: string;
	instruction: string;
	sending: boolean;
	error: string | null;
}

export interface TaskAgentContextProviderProps {
	projectId: string;
	taskId: string;
	taskCreatedAt: number;
	taskTitle: string | null;
	source: string;
	summary: RuntimeTaskSessionSummary | null;
	sendInput: (
		taskId: string,
		text: string,
		options: SendTerminalInputOptions,
	) => Promise<{ ok: boolean; message?: string }>;
	children: ReactNode;
}

export function TaskAgentContextProvider({
	projectId,
	taskId,
	taskCreatedAt,
	taskTitle,
	source,
	summary,
	sendInput,
	children,
}: TaskAgentContextProviderProps): React.ReactElement {
	const scopeKey = JSON.stringify([projectId, taskId, taskCreatedAt]);
	const [draft, setDraft] = useState<ContextDraft | null>(null);
	const draftRef = useRef(draft);
	draftRef.current = draft;
	const scopeRef = useRef(scopeKey);
	useLayoutEffect(() => {
		scopeRef.current = scopeKey;
		setDraft(null);
		return () => {
			scopeRef.current = "";
		};
	}, [scopeKey]);
	const openContext = useCallback(
		(context: AgentPromptContext) => {
			if (scopeRef.current !== scopeKey || draftRef.current?.sending) return;
			setDraft({
				context,
				scopeKey,
				sessionInstanceId: summary?.sessionInstanceId ?? null,
				source: context.source ?? source,
				instruction: "",
				sending: false,
				error: null,
			});
		},
		[scopeKey, summary?.sessionInstanceId, source],
	);
	const value = useMemo<TaskAgentContextValue>(() => ({ openContext }), [openContext]);
	const activeDraft = draft?.scopeKey === scopeKey ? draft : null;
	const prompt = activeDraft
		? buildAgentContextPrompt(activeDraft.context, activeDraft.instruction, activeDraft.source)
		: null;
	const sameSession = Boolean(
		activeDraft?.sessionInstanceId && activeDraft.sessionInstanceId === summary?.sessionInstanceId,
	);
	const ready = summary?.taskId === taskId && sameSession && canSendTaskQuickReply(summary);
	const submit = async () => {
		if (
			!activeDraft ||
			!prompt ||
			prompt.error ||
			!ready ||
			draftRef.current?.sending ||
			scopeRef.current !== scopeKey
		) {
			return;
		}
		const sendingDraft = { ...activeDraft, sending: true, error: null };
		draftRef.current = sendingDraft;
		setDraft(sendingDraft);
		let result: { ok: boolean; message?: string };
		try {
			result = await sendInput(taskId, prompt.text, {
				intent: "submit",
				appendNewline: true,
				preferTerminal: false,
				replyToSessionInstanceId: activeDraft.sessionInstanceId ?? undefined,
			});
		} catch {
			result = { ok: false, message: "Delivery could not be confirmed. Check the agent before resending." };
		}
		if (scopeRef.current !== scopeKey || draftRef.current !== sendingDraft) return;
		setDraft(
			result.ok
				? null
				: { ...sendingDraft, sending: false, error: result.message ?? "The prompt could not be sent." },
		);
	};

	return (
		<TaskAgentContext.Provider value={value}>
			{children}
			<Dialog open={activeDraft !== null} onOpenChange={(open) => !open && !activeDraft?.sending && setDraft(null)}>
				<DialogHeader title={`Ask agent: ${taskTitle || "active task"}`} />
				<DialogBody className="flex flex-col gap-3">
					<DialogDescription className="text-xs text-text-secondary">
						Review the captured context and add an instruction before sending to this task's agent.
					</DialogDescription>
					{activeDraft && prompt ? (
						<>
							<p className="m-0 break-all text-xs text-text-secondary">
								{activeDraft.context.path} · {activeDraft.source} · {activeDraft.context.location}
							</p>
							<label className="flex flex-col gap-1 text-sm text-text-primary">
								Instruction
								<textarea
									autoFocus
									rows={3}
									maxLength={TASK_QUICK_REPLY_MAX_LENGTH}
									value={activeDraft.instruction}
									disabled={activeDraft.sending}
									onChange={(event) =>
										setDraft(
											(current) => current && { ...current, instruction: event.target.value, error: null },
										)
									}
									className="rounded-md border border-border bg-surface-0 p-2 outline-none focus:border-accent"
								/>
							</label>
							<details open>
								<summary className="cursor-pointer text-xs text-text-secondary">Prompt preview</summary>
								<pre className="max-h-52 overflow-auto whitespace-pre-wrap break-words rounded-md bg-surface-0 p-2 text-xs text-text-primary">
									{prompt.text}
								</pre>
							</details>
							<p className="m-0 text-xs text-text-secondary">
								{prompt.text.length.toLocaleString()} / {TASK_QUICK_REPLY_MAX_LENGTH.toLocaleString()}{" "}
								characters
							</p>
							{!ready ? (
								<p role="status" className="m-0 text-xs text-text-secondary">
									{sameSession
										? "The agent is not ready for a reply. Your instruction is kept while you wait."
										: "The agent session changed or is unavailable. Close this dialog and capture context again."}
								</p>
							) : null}
							{activeDraft.error || prompt.error ? (
								<p role="alert" className="m-0 text-xs text-status-red">
									{activeDraft.error ?? prompt.error}
								</p>
							) : null}
						</>
					) : null}
				</DialogBody>
				<DialogFooter>
					<Button disabled={activeDraft?.sending} onClick={() => setDraft(null)}>
						Cancel
					</Button>
					<Button
						variant="primary"
						disabled={!ready || Boolean(prompt?.error) || activeDraft?.sending}
						onClick={() => void submit()}
					>
						{activeDraft?.sending ? "Sending…" : "Send to agent"}
					</Button>
				</DialogFooter>
			</Dialog>
		</TaskAgentContext.Provider>
	);
}
