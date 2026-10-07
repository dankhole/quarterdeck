import type { RuntimeShutdownOutcome } from "../core";

/** A failed startup cannot authorize another writer while owned cleanup is unconfirmed. */
export class RuntimeStartupCleanupError extends Error {
	constructor(
		readonly shutdownOutcome: RuntimeShutdownOutcome,
		cause: unknown,
	) {
		super("Runtime startup failed and its owned resources could not be cleanly stopped.", { cause });
		this.name = "RuntimeStartupCleanupError";
	}
}
