import type { RuntimeTaskImage } from "@/runtime/types";

export type TerminalImagePasteWriter = (images: RuntimeTaskImage[]) => Promise<void>;

export interface SendTerminalInputOptions {
	intent: "write" | "submit";
	appendNewline?: boolean;
	mode?: "type" | "paste";
	preferTerminal?: boolean;
	replyToSessionInstanceId?: string;
}
