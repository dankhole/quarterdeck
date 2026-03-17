import { useCallback, useEffect, useState } from "react";
import type { RuntimeTaskChatMessage } from "@/runtime/types";

export type ClineChatMessage = RuntimeTaskChatMessage;

interface UseClineChatSessionInput {
	taskId: string;
	onSendMessage?: (taskId: string, text: string) => Promise<{ ok: boolean; message?: string }>;
	onCancelTurn?: (taskId: string) => Promise<{ ok: boolean; message?: string }>;
	onLoadMessages?: (taskId: string) => Promise<ClineChatMessage[] | null>;
	incomingMessage?: ClineChatMessage | null;
}

interface UseClineChatSessionResult {
	messages: ClineChatMessage[];
	isSending: boolean;
	isCanceling: boolean;
	error: string | null;
	sendMessage: (text: string) => Promise<boolean>;
	cancelTurn: () => Promise<boolean>;
}

export function useClineChatSession({
	taskId,
	onSendMessage,
	onCancelTurn,
	onLoadMessages,
	incomingMessage = null,
}: UseClineChatSessionInput): UseClineChatSessionResult {
	const [messages, setMessages] = useState<ClineChatMessage[]>([]);
	const [isSending, setIsSending] = useState(false);
	const [isCanceling, setIsCanceling] = useState(false);
	const [isLoading, setIsLoading] = useState(false);
	const [error, setError] = useState<string | null>(null);

	useEffect(() => {
		setError(null);
		if (!onLoadMessages) {
			setMessages([]);
			return;
		}
		let cancelled = false;
		setIsLoading(true);
		void onLoadMessages(taskId)
			.then((loadedMessages) => {
				if (cancelled) {
					return;
				}
				setMessages(loadedMessages ?? []);
			})
			.catch((loadError) => {
				if (cancelled) {
					return;
				}
				const message = loadError instanceof Error ? loadError.message : String(loadError);
				setError(message);
			})
			.finally(() => {
				if (!cancelled) {
					setIsLoading(false);
				}
			});
		return () => {
			cancelled = true;
		};
	}, [onLoadMessages, taskId]);

	useEffect(() => {
		if (!incomingMessage) {
			return;
		}
		setMessages((currentMessages) => {
			const existingIndex = currentMessages.findIndex((message) => message.id === incomingMessage.id);
			if (existingIndex >= 0) {
				const existing = currentMessages[existingIndex];
				if (!existing) {
					return currentMessages;
				}
				if (
					existing.content === incomingMessage.content &&
					existing.role === incomingMessage.role &&
					existing.createdAt === incomingMessage.createdAt &&
					JSON.stringify(existing.meta ?? null) === JSON.stringify(incomingMessage.meta ?? null)
				) {
					return currentMessages;
				}
				const nextMessages = [...currentMessages];
				nextMessages[existingIndex] = incomingMessage;
				return nextMessages;
			}
			return [...currentMessages, incomingMessage];
		});
	}, [incomingMessage]);

	const cancelTurn = useCallback(async (): Promise<boolean> => {
		if (!onCancelTurn || isCanceling) {
			return false;
		}
		setError(null);
		setIsCanceling(true);
		try {
			const result = await onCancelTurn(taskId);
			if (!result.ok) {
				setError(result.message ?? "Could not cancel turn.");
				return false;
			}
			return true;
		} catch (cancelError) {
			const message = cancelError instanceof Error ? cancelError.message : String(cancelError);
			setError(message);
			return false;
		} finally {
			setIsCanceling(false);
		}
	}, [isCanceling, onCancelTurn, taskId]);

	const sendMessage = useCallback(
		async (text: string): Promise<boolean> => {
			const trimmed = text.trim();
			if (!trimmed || !onSendMessage) {
				return false;
			}

			setError(null);
			setIsSending(true);

			try {
				const result = await onSendMessage(taskId, trimmed);
				if (!result.ok) {
					const message = result.message ?? "Could not send message.";
					setError(message);
					return false;
				}
				if (onLoadMessages) {
					const loadedMessages = await onLoadMessages(taskId);
					setMessages(loadedMessages ?? []);
				}
				return true;
			} catch (sendError) {
				const message = sendError instanceof Error ? sendError.message : String(sendError);
				setError(message);
				return false;
			} finally {
				setIsSending(false);
			}
		},
		[onLoadMessages, onSendMessage, taskId],
	);

	return {
		messages,
		isSending: isSending || isLoading,
		isCanceling,
		error,
		sendMessage,
		cancelTurn,
	};
}
