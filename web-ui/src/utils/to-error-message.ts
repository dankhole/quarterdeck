/** Extract a human-readable message from an unknown caught value. */
export function toErrorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
