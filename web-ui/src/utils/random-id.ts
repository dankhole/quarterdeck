/**
 * Shared random identifier generator for client-originated command/operation
 * IDs. Prefers `crypto.randomUUID()`; falls back to a timestamp + random
 * suffix in environments where it is unavailable (older browsers, some test
 * runners). Not cryptographically significant — only used for idempotency
 * keys and durable-receipt correlation, never for security purposes.
 */
export function createRandomId(prefix: string): string {
	const suffix =
		typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
			? crypto.randomUUID()
			: `${Date.now().toString(36)}:${Math.random().toString(36).slice(2)}`;
	return `${prefix}:${suffix}`;
}
