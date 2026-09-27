import { canSendTaskQuickReply, deriveTaskIndicatorState, TASK_QUICK_REPLY_MAX_LENGTH } from "@runtime-contract";
import { ArrowUpRight, MessageSquare, Send, X } from "lucide-react";
import { useCallback, useRef, useState, useSyncExternalStore } from "react";
import { Button } from "@/components/ui/button";
import type { RuntimeTaskSessionSummary } from "@/runtime/types";
import type { BoardReplyScope } from "@/state/board-reply-drafts";
import type { BoardCard, BoardColumnId } from "@/types";

function QuickReply({
	card,
	summary,
	scope,
}: {
	card: BoardCard;
	summary?: RuntimeTaskSessionSummary;
	scope: BoardReplyScope;
}): React.ReactElement {
	const key = JSON.stringify([scope.projectId, card.id, card.createdAt]);
	const subscribe = useCallback((listener: () => void) => scope.drafts.subscribe(key, listener), [scope.drafts, key]);
	const snapshot = useCallback(() => scope.drafts.get(key), [scope.drafts, key]);
	const draft = useSyncExternalStore(subscribe, snapshot);
	const [open, setOpen] = useState(Boolean(draft.text));
	const focusReply = useRef(false);
	const [sent, setSent] = useState(false);
	const ready = canSendTaskQuickReply(summary);
	const needsInput = summary && deriveTaskIndicatorState(summary).publicStatus === "needs_input";
	const submit = async () => {
		if (!ready || !summary?.sessionInstanceId) return;
		const ok = await scope.drafts.send(key, (text) =>
			scope.sendInput(card.id, text, {
				intent: "submit",
				appendNewline: true,
				preferTerminal: false,
				replyToSessionInstanceId: summary.sessionInstanceId ?? undefined,
			}),
		);
		if (ok) {
			setOpen(false);
			setSent(true);
		}
	};
	if (!open)
		return (
			<div className="flex items-center gap-2">
				<Button
					variant="ghost"
					size="sm"
					icon={<MessageSquare size={14} />}
					onClick={() => {
						focusReply.current = true;
						setSent(false);
						setOpen(true);
					}}
				>
					{draft.text ? "Continue draft" : ready ? "Reply" : "Draft reply"}
				</Button>
				{sent ? (
					<span role="status" className="text-xs text-status-green">
						Reply sent
					</span>
				) : null}
			</div>
		);
	return (
		<form
			className="w-full pt-3"
			onSubmit={(event) => {
				event.preventDefault();
				void submit();
			}}
		>
			<div className="mb-2 flex items-center justify-between text-xs text-text-secondary">
				<label htmlFor={`reply-${card.id}`}>Reply to {card.title || "agent"}</label>
				<Button
					variant="ghost"
					size="sm"
					icon={<X size={13} />}
					aria-label="Close reply, keep draft"
					onClick={() => setOpen(false)}
				/>
			</div>
			<textarea
				id={`reply-${card.id}`}
				ref={(node) => {
					if (node && focusReply.current) {
						node.focus();
						focusReply.current = false;
					}
				}}
				rows={3}
				maxLength={TASK_QUICK_REPLY_MAX_LENGTH}
				className="w-full resize-y rounded-md border border-border-bright bg-surface-0 p-3 text-sm text-text-primary outline-none focus:border-accent disabled:opacity-60"
				placeholder="Ask a question or suggest a next step…"
				value={draft.text}
				disabled={draft.sending}
				onChange={(event) => scope.drafts.edit(key, event.target.value)}
				onKeyDown={(event) => {
					if (event.key === "Enter" && (event.metaKey || event.ctrlKey) && !event.nativeEvent.isComposing) {
						event.preventDefault();
						void submit();
					}
				}}
			/>
			{draft.error ? (
				<p role="alert" className="mt-2 text-xs text-status-red">
					{draft.error}
				</p>
			) : null}
			<div className="mt-2 flex items-center justify-between gap-3">
				<p className="text-xs text-text-secondary">
					{ready
						? "⌘ / Ctrl + Enter to send"
						: needsInput
							? "Open the agent to answer its prompt. Draft kept here."
							: "Draft saved in this window. Send when the agent is ready."}
				</p>
				<Button
					type="submit"
					variant="primary"
					size="sm"
					icon={<Send size={13} />}
					disabled={!ready || !draft.text.trim() || draft.sending}
				>
					{draft.sending ? "Sending…" : "Send"}
				</Button>
			</div>
		</form>
	);
}

export function BoardCardConversation({
	card,
	columnId,
	summary,
	replyScope,
	onOpen,
}: {
	card: BoardCard;
	columnId: BoardColumnId;
	summary?: RuntimeTaskSessionSummary;
	replyScope?: BoardReplyScope;
	onOpen?: () => void;
}): React.ReactElement {
	const latest = card.unstarted ? undefined : summary?.conversationSummaries?.at(-1);
	const finalMessage = card.unstarted ? undefined : summary?.latestHookActivity?.finalMessage?.slice(0, 500);
	const text = (finalMessage || latest?.text || (!card.unstarted && summary?.displaySummary) || card.prompt).slice(
		0,
		500,
	);
	const label = card.unstarted
		? "Task prompt"
		: latest || finalMessage
			? "Latest response"
			: summary?.displaySummary
				? "Task summary"
				: "Task prompt";
	return (
		<>
			<div className="my-4 flex-1 cursor-pointer rounded-md bg-surface-0/60 px-3 py-3">
				<div className="mb-2 flex items-center justify-between gap-2 text-[11px] text-text-secondary">
					<span>{label}</span>
					{latest && !finalMessage ? (
						<time
							dateTime={new Date(latest.capturedAt).toISOString()}
							title={new Date(latest.capturedAt).toLocaleString()}
						>
							{new Date(latest.capturedAt).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}
						</time>
					) : null}
				</div>
				<p className="m-0 line-clamp-3 whitespace-pre-wrap break-words text-[13px] leading-6 text-text-primary/90">
					{text || "No response yet. Open the agent to follow its progress."}
				</p>
			</div>
			<div
				className="flex flex-wrap items-start justify-between gap-x-2 border-t border-border pt-3"
				onClick={(event) => event.stopPropagation()}
			>
				{replyScope && !card.unstarted && columnId !== "trash" ? (
					<div className="min-w-0 flex-1 has-[form]:basis-full">
						<QuickReply card={card} summary={summary} scope={replyScope} />
					</div>
				) : (
					<span className="py-1 text-xs text-text-secondary">
						{card.unstarted ? "Ready when you are" : "In Trash"}
					</span>
				)}
				{columnId !== "trash" ? (
					<Button variant="ghost" size="sm" icon={<ArrowUpRight size={14} />} onClick={onOpen}>
						{card.unstarted ? "Edit task" : "Open agent"}
					</Button>
				) : null}
			</div>
		</>
	);
}
