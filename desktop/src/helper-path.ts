import { posix, win32 } from "node:path";

/** Windows environment names are case-insensitive; emit a single PATH key for child_process. */
export function desktopEnvironmentPath(environment: Readonly<NodeJS.ProcessEnv>, platform: NodeJS.Platform): string {
	const key =
		platform === "win32"
			? Object.keys(environment)
					.sort()
					.find((name) => name.toUpperCase() === "PATH")
			: "PATH";
	return (key ? environment[key] : undefined) ?? "";
}

export function withDesktopPath(
	environment: Readonly<NodeJS.ProcessEnv>,
	nodePath: string,
	directories: readonly string[],
	platform: NodeJS.Platform,
	fallbackDirectories: readonly string[] = [],
): NodeJS.ProcessEnv {
	const paths = platform === "win32" ? win32 : posix;
	const absolute = (path: string): boolean =>
		platform === "win32"
			? /^[A-Za-z]:[\\/]/u.test(path) || /^[\\/]{2}[^\\/.?:]+[\\/][^\\/:]+(?:[\\/]|$)/u.test(path)
			: paths.isAbsolute(path);
	if (!absolute(nodePath) || /[\0\r\n]/u.test(nodePath))
		throw new Error("The bundled Node executable must have a valid absolute path.");
	const entries = [
		paths.dirname(nodePath),
		...directories,
		...desktopEnvironmentPath(environment, platform).split(paths.delimiter),
		...fallbackDirectories,
	];
	const seen = new Set<string>();
	const valid = entries
		.filter((entry) => {
			if (!absolute(entry) || /[\0\r\n]/u.test(entry)) return false;
			const normalized = paths.normalize(entry);
			const key = platform === "win32" ? normalized.toLowerCase() : normalized;
			if (seen.has(key)) return false;
			seen.add(key);
			return true;
		})
		.map((entry) => paths.normalize(entry));
	const result = { ...environment };
	if (platform === "win32") {
		for (const key of Object.keys(result)) if (key.toUpperCase() === "PATH") delete result[key];
	}
	result.PATH = valid.join(paths.delimiter);
	return result;
}
