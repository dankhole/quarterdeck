import type { RuntimeTaskImage } from "@/runtime/types";

export type TerminalImagePasteWriter = (images: RuntimeTaskImage[]) => Promise<void>;

export interface TerminalPasteOptions {
	/** Require an attached agent with bracketed paste enabled. */
	asAgentDraft?: boolean;
}

export type SendTerminalInputOptions =
	| {
			intent: "write";
			appendNewline: false;
			mode: "paste";
			asAgentDraft: true;
			preferTerminal?: true;
			replyToSessionInstanceId?: never;
	  }
	| {
			intent: "write" | "submit";
			appendNewline?: boolean;
			mode?: "type" | "paste";
			asAgentDraft?: false;
			preferTerminal?: boolean;
			replyToSessionInstanceId?: string;
	  };
