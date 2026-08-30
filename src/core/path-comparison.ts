import { posix, win32 } from "node:path";

function getPathApi(platform: NodeJS.Platform): typeof posix | typeof win32 {
	return platform === "win32" ? win32 : posix;
}

function removeWindowsNamespacePrefix(path: string): string {
	const normalizedSeparators = path.replaceAll("/", "\\");
	if (/^\\\\\?\\unc\\/iu.test(normalizedSeparators)) {
		return `\\\\${normalizedSeparators.slice(8)}`;
	}
	if (/^\\\\\?\\[A-Za-z]:\\/u.test(normalizedSeparators)) {
		return normalizedSeparators.slice(4);
	}
	return path;
}

export function normalizeFileSystemPathForComparison(
	path: string,
	platform: NodeJS.Platform = process.platform,
): string {
	const normalized = platform === "win32" ? win32.resolve(removeWindowsNamespacePrefix(path)) : posix.resolve(path);
	return platform === "win32" ? normalized.toLowerCase() : normalized;
}

export function areFileSystemPathsEqual(
	left: string,
	right: string,
	platform: NodeJS.Platform = process.platform,
): boolean {
	return (
		normalizeFileSystemPathForComparison(left, platform) === normalizeFileSystemPathForComparison(right, platform)
	);
}

export function isFileSystemPathWithin(
	root: string,
	candidate: string,
	platform: NodeJS.Platform = process.platform,
): boolean {
	const pathApi = getPathApi(platform);
	const normalizedRoot = normalizeFileSystemPathForComparison(root, platform);
	const normalizedCandidate = normalizeFileSystemPathForComparison(candidate, platform);
	const relativePath = pathApi.relative(normalizedRoot, normalizedCandidate);
	return (
		relativePath === "" ||
		(relativePath !== ".." && !relativePath.startsWith(`..${pathApi.sep}`) && !pathApi.isAbsolute(relativePath))
	);
}
