import type { SendTerminalInputOptions } from "@/terminal/terminal-input";

export interface BoardReplyDraft {
	readonly text: string;
	readonly sending: boolean;
	readonly error: string | null;
}
const EMPTY_DRAFT: BoardReplyDraft = { text: "", sending: false, error: null };

/** Browser-session drafts outlive card/navigation mounts; typing only notifies this draft's listeners. */
export class BoardReplyDrafts {
	private readonly drafts = new Map<string, BoardReplyDraft>();
	private readonly listeners = new Map<string, Set<() => void>>();

	get = (key: string): BoardReplyDraft => this.drafts.get(key) ?? EMPTY_DRAFT;
	subscribe = (key: string, listener: () => void): (() => void) => {
		const listeners = this.listeners.get(key) ?? new Set();
		listeners.add(listener);
		this.listeners.set(key, listeners);
		return () => {
			listeners.delete(listener);
			if (listeners.size === 0) this.listeners.delete(key);
		};
	};
	private set(key: string, value: BoardReplyDraft): void {
		if (!value.text && !value.sending && !value.error) this.drafts.delete(key);
		else this.drafts.set(key, value);
		for (const listener of this.listeners.get(key) ?? []) listener();
	}
	edit(key: string, text: string): void {
		if (!this.get(key).sending) this.set(key, { text, sending: false, error: null });
	}
	async send(key: string, submit: (text: string) => Promise<{ ok: boolean; message?: string }>): Promise<boolean> {
		const draft = this.get(key);
		if (draft.sending || !draft.text.trim()) return false;
		this.set(key, { ...draft, sending: true, error: null });
		try {
			const result = await submit(draft.text);
			this.set(
				key,
				result.ok
					? EMPTY_DRAFT
					: { ...draft, sending: false, error: result.message ?? "Reply failed. Your draft is saved." },
			);
			return result.ok;
		} catch {
			this.set(key, {
				...draft,
				sending: false,
				error: "Delivery could not be confirmed. Check the agent before resending.",
			});
			return false;
		}
	}
}

export interface BoardReplyScope {
	projectId: string;
	drafts: BoardReplyDrafts;
	sendInput: (
		taskId: string,
		text: string,
		options: SendTerminalInputOptions,
	) => Promise<{ ok: boolean; message?: string }>;
}
