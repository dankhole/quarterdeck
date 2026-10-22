const MAX_PROVIDER_TITLE_LENGTH = 80;

export function hasControlCharacters(value: string): boolean {
	return Array.from(value).some((character) => {
		const code = character.codePointAt(0) ?? 0;
		return code < 32 || code === 127;
	});
}

/**
 * Normalizes a provider-native task name (Codex thread name, Claude custom
 * title). Returns null for a name with control characters, which callers skip,
 * and "" for an explicitly empty name.
 */
export function normalizeProviderTaskTitle(rawName: string): string | null {
	const name = rawName.replace(/\s+/gu, " ").trim();
	if (hasControlCharacters(name)) return null;
	return Array.from(name).slice(0, MAX_PROVIDER_TITLE_LENGTH).join("").trimEnd();
}
