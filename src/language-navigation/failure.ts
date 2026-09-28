export interface LanguageNavigationFailureMetadata {
	stage: "admission" | "initialization" | "request" | "shutdown";
	category:
		| "unavailable"
		| "invalid_document"
		| "scope_changed"
		| "process_limit"
		| "queue_limit"
		| "spawn_failed"
		| "process_exited"
		| "output_limit"
		| "timeout"
		| "protocol_error"
		| "stopped"
		| "stop_failed"
		| "internal_error";
	exitCode?: number;
	signal?: NodeJS.Signals;
}

/** Public messages are authored locally; diagnostic causes never retain arbitrary server output. */
export class LanguageNavigationError extends Error {
	constructor(
		message: string,
		readonly unavailable: boolean,
		readonly metadata: LanguageNavigationFailureMetadata,
	) {
		super(message);
	}
}
