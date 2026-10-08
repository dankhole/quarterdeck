const listeners = new Set<() => void>();

/** A project save can also change global fields, so every config scope refreshes. */
export function invalidateRuntimeConfig(): void {
	for (const listener of listeners) listener();
}

export function subscribeRuntimeConfigInvalidation(listener: () => void): () => void {
	listeners.add(listener);
	return () => listeners.delete(listener);
}
