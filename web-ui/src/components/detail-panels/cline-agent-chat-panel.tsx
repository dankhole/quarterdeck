import { type ReactElement, useLayoutEffect, useMemo, useRef, useState } from "react";
import { Brain, ChevronDown, ChevronRight, Wrench } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { ClineMarkdownContent } from "@/components/detail-panels/cline-markdown-content";
import { parseToolMessageContent } from "@/components/detail-panels/cline-chat-message-utils";
import { type ClineChatMessage, useClineChatSession } from "@/hooks/use-cline-chat-session";
import type { RuntimeTaskSessionSummary } from "@/runtime/types";

function ToolMessageBlock({ message }: { message: ClineChatMessage }): ReactElement {
	const parsed = useMemo(() => parseToolMessageContent(message.content), [message.content]);
	const isRunning = message.meta?.hookEventName === "tool_call_start";
	const hasError = Boolean(parsed.error);
	const [expanded, setExpanded] = useState(false);
	const statusText = hasError ? "Failed" : isRunning ? "Running" : "Completed";
	const statusClasses = hasError
		? "text-status-red"
		: isRunning
			? "text-status-orange"
			: "text-status-green";

	return (
		<div className="w-full rounded-md border border-border bg-status-blue/5 px-2 py-2">
			<button
				type="button"
				onClick={() => setExpanded((current) => !current)}
				className="flex w-full items-center justify-between gap-2 text-left"
			>
				<div className="min-w-0">
					<div className="flex items-center gap-2 text-xs uppercase tracking-wide text-text-tertiary">
						<Wrench size={12} />
						<span>Tool</span>
						<span className={statusClasses}>{statusText}</span>
					</div>
					<div className="truncate text-sm text-text-primary">{parsed.toolName}</div>
				</div>
				<div className="flex items-center gap-2 text-xs text-text-secondary">
					{typeof parsed.durationMs === "number" ? <span>{parsed.durationMs}ms</span> : null}
					{expanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
				</div>
			</button>
			{expanded ? (
				<div className="mt-2 space-y-2">
					{parsed.input ? (
						<div>
							<div className="mb-1 text-[11px] uppercase tracking-wide text-text-tertiary">Input</div>
							<pre className="max-h-44 overflow-auto rounded border border-border bg-surface-1 px-2 py-1 text-xs whitespace-pre-wrap break-all text-text-secondary">
								{parsed.input}
							</pre>
						</div>
					) : null}
					{parsed.output ? (
						<div>
							<div className="mb-1 text-[11px] uppercase tracking-wide text-text-tertiary">Output</div>
							<pre className="max-h-56 overflow-auto rounded border border-border bg-surface-1 px-2 py-1 text-xs whitespace-pre-wrap break-all text-text-primary">
								{parsed.output}
							</pre>
						</div>
					) : null}
					{parsed.error ? (
						<div>
							<div className="mb-1 text-[11px] uppercase tracking-wide text-status-red">Error</div>
							<pre className="max-h-56 overflow-auto rounded border border-status-red/40 bg-status-red/10 px-2 py-1 text-xs whitespace-pre-wrap break-all text-status-red">
								{parsed.error}
							</pre>
						</div>
					) : null}
				</div>
			) : null}
		</div>
	);
}

function ReasoningMessageBlock({ message }: { message: ClineChatMessage }): ReactElement {
	return (
		<div className="w-full">
			<div className="mb-1 flex items-center gap-1.5 text-[11px] uppercase tracking-wide text-status-purple">
				<Brain size={12} />
				<span>Reasoning</span>
			</div>
			<div className="w-full text-sm whitespace-pre-wrap text-text-secondary">{message.content}</div>
		</div>
	);
}

function ChatMessageItem({ message }: { message: ClineChatMessage }): ReactElement {
	if (message.role === "tool") {
		return <ToolMessageBlock message={message} />;
	}
	if (message.role === "reasoning") {
		return <ReasoningMessageBlock message={message} />;
	}
	if (message.role === "user") {
		return (
			<div className="ml-auto max-w-[85%] rounded-md bg-accent/20 px-3 py-2 text-sm whitespace-pre-wrap text-text-primary">
				{message.content}
			</div>
		);
	}
	if (message.role === "assistant") {
		const normalizedAssistantContent = message.content.replace(/^\n+/, "");
		return (
			<div className="w-full text-sm whitespace-pre-wrap text-text-primary">
				<ClineMarkdownContent content={normalizedAssistantContent} />
			</div>
		);
	}
	const label = message.role === "status" ? "Status" : "System";
	return (
		<div className="max-w-[85%] rounded-md border border-border bg-surface-3/70 px-3 py-2 text-sm whitespace-pre-wrap text-text-secondary">
			<div className="mb-1 text-[11px] uppercase tracking-wide text-text-tertiary">{label}</div>
			{message.content}
		</div>
	);
}

export interface ClineAgentChatPanelProps {
	taskId: string;
	summary: RuntimeTaskSessionSummary | null;
	taskColumnId?: string;
	onSendMessage?: (taskId: string, text: string) => Promise<{ ok: boolean; message?: string }>;
	onCancelTurn?: (taskId: string) => Promise<{ ok: boolean; message?: string }>;
	onLoadMessages?: (taskId: string) => Promise<ClineChatMessage[] | null>;
	incomingMessage?: ClineChatMessage | null;
	onCommit?: () => void;
	onOpenPr?: () => void;
	isCommitLoading?: boolean;
	isOpenPrLoading?: boolean;
	onMoveToTrash?: () => void;
	isMoveToTrashLoading?: boolean;
	onCancelAutomaticAction?: () => void;
	cancelAutomaticActionLabel?: string | null;
	showMoveToTrash?: boolean;
}

export function ClineAgentChatPanel({
	taskId,
	summary,
	taskColumnId = "in_progress",
	onSendMessage,
	onCancelTurn,
	onLoadMessages,
	incomingMessage,
	onCommit,
	onOpenPr,
	isCommitLoading = false,
	isOpenPrLoading = false,
	onMoveToTrash,
	isMoveToTrashLoading = false,
	onCancelAutomaticAction,
	cancelAutomaticActionLabel,
	showMoveToTrash = false,
}: ClineAgentChatPanelProps): ReactElement {
	const [draft, setDraft] = useState("");
	const messagesContainerRef = useRef<HTMLDivElement | null>(null);
	const messageEndRef = useRef<HTMLDivElement | null>(null);
	const { messages, isSending, isCanceling, error, sendMessage, cancelTurn } = useClineChatSession({
		taskId,
		onSendMessage,
		onCancelTurn,
		onLoadMessages,
		incomingMessage,
	});
	const canSend = Boolean(onSendMessage) && !isSending && !isCanceling;
	const canCancel = Boolean(onCancelTurn) && summary?.state === "running" && !isCanceling;
	const showReviewActions = taskColumnId === "review" && Boolean(onCommit) && Boolean(onOpenPr);
	const showAgentProgressIndicator = summary?.state === "running";
	const showActionFooter = showMoveToTrash && Boolean(onMoveToTrash);
	const showCancelAutomaticAction = Boolean(cancelAutomaticActionLabel && onCancelAutomaticAction);

	useLayoutEffect(() => {
		if (!messagesContainerRef.current || !messageEndRef.current) {
			return;
		}
		messageEndRef.current.scrollIntoView({ block: "end" });
	}, [messages, showAgentProgressIndicator, showActionFooter, showReviewActions, showCancelAutomaticAction]);

	return (
		<div className="flex min-h-0 min-w-0 flex-1 flex-col border-r border-border bg-surface-0">
			<div ref={messagesContainerRef} className="flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto px-3 py-3">
				{messages.length === 0 ? (
					<div className="text-sm text-text-secondary">Send a message to start chatting with Cline.</div>
				) : (
					messages.map((message) => <ChatMessageItem key={message.id} message={message} />)
				)}
				{showAgentProgressIndicator ? (
					<div className="flex items-center gap-2 px-1 text-xs text-text-secondary">
						<Spinner size={12} />
						<span>Thinking...</span>
					</div>
				) : null}
				<div ref={messageEndRef} aria-hidden="true" />
			</div>
			{error ? <div className="border-t border-status-red/30 bg-status-red/10 px-3 py-2 text-xs text-status-red">{error}</div> : null}
			<div className="border-t border-border px-3 py-3">
				<textarea
					value={draft}
					onChange={(event) => setDraft(event.target.value)}
					placeholder="Ask Cline to make progress on this task"
					disabled={!canSend}
					rows={3}
					className="w-full resize-none rounded-md border border-border bg-surface-2 px-2 py-2 text-sm text-text-primary placeholder:text-text-tertiary focus:border-border-focus focus:outline-none disabled:opacity-50"
				/>
				<div className="mt-2 flex items-center justify-end gap-2">
					{onCancelTurn ? (
						<Button
							variant="default"
							size="sm"
							disabled={!canCancel}
							onClick={() => {
								void cancelTurn();
							}}
						>
							{isCanceling ? <Spinner size={14} /> : "Cancel"}
						</Button>
					) : null}
					<Button
						variant="primary"
						size="sm"
						disabled={!canSend || draft.trim().length === 0}
						onClick={() => {
							void (async () => {
								const sent = await sendMessage(draft);
								if (sent) {
									setDraft("");
								}
							})();
						}}
					>
						{isSending ? <Spinner size={14} /> : "Send"}
					</Button>
				</div>
			</div>
			{showActionFooter ? (
				<div className="flex flex-col gap-2 px-3 pb-3">
					{showReviewActions ? (
						<div className="flex gap-2">
							<Button
								variant="primary"
								size="sm"
								fill
								disabled={isCommitLoading || isOpenPrLoading}
								onClick={onCommit}
							>
								{isCommitLoading ? "..." : "Commit"}
							</Button>
							<Button
								variant="primary"
								size="sm"
								fill
								disabled={isCommitLoading || isOpenPrLoading}
								onClick={onOpenPr}
							>
								{isOpenPrLoading ? "..." : "Open PR"}
							</Button>
						</div>
					) : null}
					{cancelAutomaticActionLabel && onCancelAutomaticAction ? (
						<Button variant="default" fill onClick={onCancelAutomaticAction}>
							{cancelAutomaticActionLabel}
						</Button>
					) : null}
					<Button variant="danger" fill disabled={isMoveToTrashLoading} onClick={onMoveToTrash}>
						{isMoveToTrashLoading ? <Spinner size={14} /> : "Move Card To Trash"}
					</Button>
				</div>
			) : null}
		</div>
	);
}
