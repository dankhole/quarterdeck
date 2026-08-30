/**
 * Merge child-process environment records using the host's key semantics.
 * Windows treats names case-insensitively, while ordinary JavaScript objects
 * do not; leaving both `Path` and `PATH` lets Node choose one by key sorting
 * instead of by the caller's intended precedence.
 */
export function mergeProcessEnvironment(
	base: Readonly<NodeJS.ProcessEnv>,
	overrides: Readonly<NodeJS.ProcessEnv>,
	platform: NodeJS.Platform = process.platform,
): NodeJS.ProcessEnv {
	if (platform !== "win32") {
		return { ...base, ...overrides };
	}

	const merged: NodeJS.ProcessEnv = {};
	const keyByIdentity = new Map<string, string>();
	const apply = (source: Readonly<NodeJS.ProcessEnv>): void => {
		for (const [key, value] of Object.entries(source)) {
			const identity = key.toLowerCase();
			const previousKey = keyByIdentity.get(identity);
			if (previousKey) delete merged[previousKey];
			keyByIdentity.delete(identity);
			if (value === undefined) continue;
			merged[key] = value;
			keyByIdentity.set(identity, key);
		}
	};
	apply(base);
	apply(overrides);
	return merged;
}
