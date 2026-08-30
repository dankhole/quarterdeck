import { win32 } from "node:path";

const WINDOWS_POWERSHELL_RELATIVE_PATH = ["System32", "WindowsPowerShell", "v1.0", "powershell.exe"];
const DEFAULT_WINDOWS_PATH_EXTENSIONS = [".com", ".exe", ".bat", ".cmd"];

// `process.env` is case-insensitive on Windows, but copied environment objects
// are ordinary JavaScript records and need that behavior reproduced explicitly.
export function getWindowsEnvironmentValue(env: Readonly<NodeJS.ProcessEnv>, key: string): string | undefined {
	const directValue = env[key];
	if (typeof directValue === "string") {
		return directValue;
	}

	const normalizedKey = key.toLowerCase();
	for (const [entryKey, entryValue] of Object.entries(env)) {
		if (entryKey.toLowerCase() === normalizedKey && typeof entryValue === "string") {
			return entryValue;
		}
	}
	return undefined;
}

export function getWindowsPathEntries(env: NodeJS.ProcessEnv): string[] {
	return (getWindowsEnvironmentValue(env, "PATH") ?? "")
		.split(";")
		.map((entry) => {
			// Whitespace is legal inside a Windows path component. Preserve it
			// exactly; only remove a pair of quotes that encloses the whole entry.
			return entry.startsWith('"') && entry.endsWith('"') ? entry.slice(1, -1) : entry;
		})
		.filter((entry) => entry.length > 0);
}

export function getWindowsPathExtensions(env: NodeJS.ProcessEnv): string[] {
	const configured = getWindowsEnvironmentValue(env, "PATHEXT")
		?.split(";")
		.map((extension) => extension.trim())
		.filter(Boolean)
		.map((extension) => (extension.startsWith(".") ? extension : `.${extension}`).toLowerCase());
	return configured && configured.length > 0 ? configured : DEFAULT_WINDOWS_PATH_EXTENSIONS;
}

function resolveWindowsSystemRoot(env: NodeJS.ProcessEnv): string {
	const configuredRoot =
		getWindowsEnvironmentValue(env, "SystemRoot")?.trim() || getWindowsEnvironmentValue(env, "WINDIR")?.trim();
	return configuredRoot && win32.isAbsolute(configuredRoot) && !/["\r\n]/u.test(configuredRoot)
		? configuredRoot
		: "C:\\Windows";
}

function assertWindowsSystemExecutableName(executableName: string): void {
	if (!/^[a-z0-9._-]+$/iu.test(executableName)) {
		throw new Error("Windows system executable name must not contain a path or shell syntax.");
	}
}

export function resolveWindowsRootExecutablePath(executableName: string, env: NodeJS.ProcessEnv = process.env): string {
	assertWindowsSystemExecutableName(executableName);
	return win32.join(resolveWindowsSystemRoot(env), executableName);
}

export function resolveWindowsSystem32ExecutablePath(
	executableName: string,
	env: NodeJS.ProcessEnv = process.env,
): string {
	assertWindowsSystemExecutableName(executableName);
	return win32.join(resolveWindowsSystemRoot(env), "System32", executableName);
}

export function resolveWindowsPowerShellPath(env: NodeJS.ProcessEnv = process.env): string {
	return win32.join(resolveWindowsSystemRoot(env), ...WINDOWS_POWERSHELL_RELATIVE_PATH);
}
