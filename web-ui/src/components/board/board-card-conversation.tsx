import * as Collapsible from "@radix-ui/react-collapsible";
import { canSendTaskQuickReply, deriveTaskIndicatorState, TASK_QUICK_REPLY_MAX_LENGTH } from "@runtime-contract";
import { ChevronRight, MessageSquare, Send, X } from "lucide-react";
import { type ReactNode, useCallback, useRef, useState, useSyncExternalStore } from "react";
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
	const status = summary && deriveTaskIndicatorState(summary).publicStatus;
	const needsInput = status === "needs_input";
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
			className="w-full"
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
				className="w-full resize-y rounded-md border border-border-bright bg-surface-0 p-2 text-xs text-text-primary outline-none focus:border-accent disabled:opacity-60"
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
							: status === "running"
								? "Agent is running. Send when it finishes. Draft saved in this window."
								: "Agent is not ready for replies. Draft saved in this window."}
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
	statusBadges,
	readOnly = false,
}: {
	card: BoardCard;
	columnId: BoardColumnId;
	summary?: RuntimeTaskSessionSummary;
	replyScope?: BoardReplyScope;
	statusBadges?: ReactNode;
	readOnly?: boolean;
}): React.ReactElement {
	const latest = card.unstarted ? undefined : summary?.conversationSummaries?.at(-1);
	const finalMessage = card.unstarted ? undefined : summary?.latestHookActivity?.finalMessage?.slice(0, 500);
	const running = !card.unstarted && summary && deriveTaskIndicatorState(summary).publicStatus === "running";
	const completedResponse = finalMessage || latest?.text || (!card.unstarted && summary?.displaySummary);
	const text = (
		running
			? summary.progressMessage?.trim()
				? summary.progressMessage
				: "Working…"
			: completedResponse || card.prompt
	).slice(0, 500);
	return (
		<>
			<div className="my-2 min-h-[120px] flex-1 rounded-md bg-surface-0/60 px-2 py-1.5">
				<p className="m-0 line-clamp-6 whitespace-pre-wrap break-words text-xs leading-[18px] text-text-primary/90">
					{text || "No response yet. Open the agent to follow its progress."}
				</p>
				{running && completedResponse ? (
					<Collapsible.Root
						className="mt-2 border-t border-border pt-1.5"
						onClick={(event) => event.stopPropagation()}
						onDoubleClick={(event) => event.stopPropagation()}
					>
						<Collapsible.Trigger className="group flex items-center gap-1 rounded-sm text-xs text-text-secondary hover:text-text-primary focus-visible:outline-2 focus-visible:outline-border-focus">
							<ChevronRight size={12} aria-hidden className="group-data-[state=open]:rotate-90" />
							Previous response
						</Collapsible.Trigger>
						<Collapsible.Content>
							<p className="mb-0 mt-1.5 line-clamp-6 whitespace-pre-wrap break-words text-xs leading-[18px] text-text-secondary">
								{completedResponse.slice(0, 500)}
							</p>
						</Collapsible.Content>
					</Collapsible.Root>
				) : null}
			</div>
			<div
				className="flex flex-wrap items-center justify-between gap-2 border-t border-border pt-1.5"
				onClick={(event) => event.stopPropagation()}
			>
				{!readOnly && replyScope && !card.unstarted && columnId !== "trash" ? (
					<div className="min-w-0 flex-1 has-[form]:basis-full has-[form]:order-last">
						<QuickReply card={card} summary={summary} scope={replyScope} />
					</div>
				) : (
					<span className="py-1 text-xs text-text-secondary">
						{readOnly
							? "Saved task"
							: card.unstarted
								? "Ready when you are"
								: columnId === "trash"
									? "In Trash"
									: ""}
					</span>
				)}
				{statusBadges}
			</div>
		</>
	);
}
