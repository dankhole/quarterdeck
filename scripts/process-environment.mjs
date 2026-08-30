/** Read an environment key using the host platform's name semantics. */
export function getProcessEnvironmentValue(env, key, platform = process.platform) {
	if (platform !== "win32") return env[key];
	const normalizedKey = key.toLowerCase();
	for (const [entryKey, value] of Object.entries(env)) {
		if (entryKey.toLowerCase() === normalizedKey && typeof value === "string") return value;
	}
	return undefined;
}

/** Merge environment records without leaving case aliases on Windows. */
export function mergeProcessEnvironment(base, overrides, platform = process.platform) {
	if (platform !== "win32") return { ...base, ...overrides };
	const merged = {};
	const keyByIdentity = new Map();
	for (const source of [base, overrides]) {
		for (const [key, value] of Object.entries(source)) {
			const identity = key.toLowerCase();
			const previousKey = keyByIdentity.get(identity);
			if (previousKey) delete merged[previousKey];
			keyByIdentity.delete(identity);
			if (value === undefined) continue;
			merged[key] = value;
			keyByIdentity.set(identity, key);
		}
	}
	return merged;
}
