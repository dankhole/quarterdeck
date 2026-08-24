export interface SendTerminalInputOptions {
	intent: "write" | "submit";
	appendNewline?: boolean;
	mode?: "type" | "paste";
	preferTerminal?: boolean;
}
