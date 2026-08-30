const WINDOWS_DRIVE_ABSOLUTE_PATH = /^[A-Za-z]:[\\/]/u;
const WINDOWS_UNC_PATH = /^(?:\\\\|\/\/)[^\\/]+[\\/][^\\/]+/u;

function removeWindowsNamespacePrefix(path: string): string {
	const normalizedSeparators = path.replaceAll("\\", "/");
	if (/^\/\/\?\/unc\//iu.test(normalizedSeparators)) {
		return `//${normalizedSeparators.slice(8)}`;
	}
	if (/^\/\/\?\/[A-Za-z]:\//u.test(normalizedSeparators)) {
		return normalizedSeparators.slice(4);
	}
	return path;
}

function isWindowsAbsolutePath(path: string): boolean {
	return WINDOWS_DRIVE_ABSOLUTE_PATH.test(path) || WINDOWS_UNC_PATH.test(path);
}

export function normalizePathIdentity(path: string | null | undefined): string | null {
	if (path === null || path === undefined || path.trim().length === 0) return null;

	const withoutNamespacePrefix = removeWindowsNamespacePrefix(path);
	const windowsPath = isWindowsAbsolutePath(withoutNamespacePrefix);
	const normalized = windowsPath ? withoutNamespacePrefix.replaceAll("\\", "/") : withoutNamespacePrefix;
	if (/^[A-Za-z]:\/+$/u.test(normalized)) {
		return `${normalized.slice(0, 2)}/`;
	}
	return normalized.replace(/\/+$/u, "") || "/";
}

export function arePathIdentitiesEqual(left: string | null | undefined, right: string | null | undefined): boolean {
	const normalizedLeft = normalizePathIdentity(left);
	const normalizedRight = normalizePathIdentity(right);
	if (normalizedLeft === null || normalizedRight === null) return false;
	if (isWindowsAbsolutePath(normalizedLeft) && isWindowsAbsolutePath(normalizedRight)) {
		return normalizedLeft.toLowerCase() === normalizedRight.toLowerCase();
	}
	return normalizedLeft === normalizedRight;
}

export function areOptionalPathIdentitiesEqual(
	left: string | null | undefined,
	right: string | null | undefined,
): boolean {
	const normalizedLeft = normalizePathIdentity(left);
	const normalizedRight = normalizePathIdentity(right);
	if (normalizedLeft === null || normalizedRight === null) {
		return normalizedLeft === normalizedRight;
	}
	return arePathIdentitiesEqual(normalizedLeft, normalizedRight);
}
