import { z } from "zod";

export const runtimeShutdownIncompleteReasonSchema = z.enum([
	"deadline",
	"quiescence_failed",
	"persistence_failed",
	"processes_unconfirmed",
	"server_close_failed",
	"ownership_lost",
	"session_cleanup_skipped",
]);
export type RuntimeShutdownIncompleteReason = z.infer<typeof runtimeShutdownIncompleteReasonSchema>;

/** A bounded report is permission to release ownership only when it is clean. */
export const runtimeShutdownOutcomeSchema = z.discriminatedUnion("status", [
	z
		.object({
			status: z.literal("clean"),
			safeToExit: z.literal(true),
			safeToReleaseOwnership: z.literal(true),
		})
		.strict(),
	z
		.object({
			status: z.literal("incomplete"),
			safeToExit: z.literal(false),
			safeToReleaseOwnership: z.literal(false),
			reasons: z.array(runtimeShutdownIncompleteReasonSchema).min(1).max(7),
		})
		.strict(),
]);
export type RuntimeShutdownOutcome = z.infer<typeof runtimeShutdownOutcomeSchema>;

/** Exact-owned process cleanup must confirm descendants, not just signal roots. */
export type RuntimeOwnedProcessShutdownOutcome = { status: "stopped" } | { status: "unconfirmed" };
