interface HomePrefix {
	path: string;
	caseInsensitive: boolean;
}

function normalizeDisplayPath(path: string): string {
	const normalizedSeparators = path.replaceAll("\\", "/");
	if (/^\/\/\?\/unc\//iu.test(normalizedSeparators)) {
		return `//${normalizedSeparators.slice(8)}`;
	}
	if (/^\/\/\?\/[A-Za-z]:\//u.test(normalizedSeparators)) {
		return normalizedSeparators.slice(4);
	}
	return normalizedSeparators;
}

function detectHomePrefix(path: string): HomePrefix | null {
	const normalized = normalizeDisplayPath(path);
	const unixMatch = normalized.match(/^\/(?:Users|home)\/[^/]+/);
	if (unixMatch?.[0]) {
		return { path: unixMatch[0], caseInsensitive: false };
	}
	const windowsMatch = normalized.match(/^[A-Za-z]:\/Users\/[^/]+/i);
	if (windowsMatch?.[0]) {
		return { path: windowsMatch[0], caseInsensitive: true };
	}
	return null;
}

export function formatPathForDisplay(path: string): string {
	const normalized = normalizeDisplayPath(path);
	const homePrefix = detectHomePrefix(normalized);
	if (!homePrefix) {
		return normalized;
	}
	const comparisonPath = homePrefix.caseInsensitive ? normalized.toLowerCase() : normalized;
	const comparisonHomePrefix = homePrefix.caseInsensitive ? homePrefix.path.toLowerCase() : homePrefix.path;
	if (comparisonPath === comparisonHomePrefix) {
		return "~";
	}
	if (comparisonPath.startsWith(`${comparisonHomePrefix}/`)) {
		return `~/${normalized.slice(homePrefix.path.length + 1)}`;
	}
	return normalized;
}
