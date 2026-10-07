import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { chmod, lstat, mkdir, open, rename, rm } from "node:fs/promises";
import { delimiter, dirname, isAbsolute, join, normalize } from "node:path";

const MAX_DIRECTORIES = 16;
const MAX_PATH_BYTES = 4_096;
const MAX_PREFERENCES_BYTES = 32_768;

export interface DesktopEnvironmentPreferences {
	version: 1;
	extraExecutableDirectories: string[];
}

export class DesktopEnvironmentPreferencesError extends Error {
	readonly code = "DesktopEnvironmentPreferencesInvalid";
	constructor() {
		super("Saved executable folders could not be read or saved. Reset them in Runtime Environment and try again.");
		this.name = "DesktopEnvironmentPreferencesError";
	}
}

/** Only directories are persisted. Environment values, commands, and credentials are never accepted. */
export function validateDesktopEnvironmentPreferences(value: unknown): DesktopEnvironmentPreferences {
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new DesktopEnvironmentPreferencesError();
	const record = value as Record<string, unknown>;
	if (
		Object.keys(record).some((key) => key !== "version" && key !== "extraExecutableDirectories") ||
		record.version !== 1 ||
		!Array.isArray(record.extraExecutableDirectories) ||
		record.extraExecutableDirectories.length > MAX_DIRECTORIES
	)
		throw new DesktopEnvironmentPreferencesError();
	const directories: string[] = [];
	for (const entry of record.extraExecutableDirectories) {
		if (
			typeof entry !== "string" ||
			!isAbsolute(entry) ||
			/[\0\r\n]/u.test(entry) ||
			entry.includes(delimiter) ||
			Buffer.byteLength(entry) > MAX_PATH_BYTES
		) {
			throw new DesktopEnvironmentPreferencesError();
		}
		const directory = normalize(entry);
		if (!directories.includes(directory)) directories.push(directory);
	}
	const preferences: DesktopEnvironmentPreferences = { version: 1, extraExecutableDirectories: directories };
	if (Buffer.byteLength(JSON.stringify(preferences)) > MAX_PREFERENCES_BYTES)
		throw new DesktopEnvironmentPreferencesError();
	return preferences;
}

function preferencesPaths(userDataPath: string): { directory: string; file: string } {
	if (!isAbsolute(userDataPath) || /[\0\r\n]/u.test(userDataPath)) throw new DesktopEnvironmentPreferencesError();
	const directory = join(userDataPath, "environment-preferences");
	return { directory, file: join(directory, "folders.json") };
}

export async function readDesktopEnvironmentPreferences(userDataPath: string): Promise<DesktopEnvironmentPreferences> {
	const paths = preferencesPaths(userDataPath);
	try {
		const directory = await lstat(paths.directory);
		if (!directory.isDirectory() || directory.isSymbolicLink()) throw new DesktopEnvironmentPreferencesError();
		const handle = await open(paths.file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
		try {
			const info = await handle.stat();
			if (!info.isFile() || info.size > MAX_PREFERENCES_BYTES) throw new DesktopEnvironmentPreferencesError();
			// Bound the actual read too: the file may grow after stat.
			const bytes = Buffer.alloc(MAX_PREFERENCES_BYTES + 1);
			const { bytesRead } = await handle.read(bytes, 0, bytes.length, 0);
			if (bytesRead > MAX_PREFERENCES_BYTES) throw new DesktopEnvironmentPreferencesError();
			return validateDesktopEnvironmentPreferences(JSON.parse(bytes.subarray(0, bytesRead).toString("utf8")));
		} finally {
			await handle.close();
		}
	} catch (error) {
		if (error && typeof error === "object" && "code" in error && error.code === "ENOENT")
			return { version: 1, extraExecutableDirectories: [] };
		throw new DesktopEnvironmentPreferencesError();
	}
}

export async function writeDesktopEnvironmentPreferences(
	userDataPath: string,
	value: DesktopEnvironmentPreferences,
): Promise<void> {
	const preferences = validateDesktopEnvironmentPreferences(value);
	const paths = preferencesPaths(userDataPath);
	const temporary = join(paths.directory, `${randomUUID()}.tmp`);
	try {
		await mkdir(paths.directory, { recursive: true, mode: 0o700 });
		const directory = await lstat(paths.directory);
		if (!directory.isDirectory() || directory.isSymbolicLink()) throw new DesktopEnvironmentPreferencesError();
		await chmod(paths.directory, 0o700);
		const handle = await open(temporary, "wx", 0o600);
		try {
			await handle.writeFile(`${JSON.stringify(preferences)}\n`, "utf8");
			await handle.sync();
		} finally {
			await handle.close();
		}
		await rename(temporary, paths.file);
		if (process.platform !== "win32") {
			const parent = await open(paths.directory, "r");
			try {
				await parent.sync();
			} finally {
				await parent.close();
			}
		}
	} catch {
		throw new DesktopEnvironmentPreferencesError();
	} finally {
		await rm(temporary, { force: true });
	}
}

/** Bundled Node keeps precedence; user-selected folders precede captured executable folders. */
export function applyDesktopExecutableDirectories(
	environment: Readonly<NodeJS.ProcessEnv>,
	nodePath: string,
	directories: readonly string[],
): NodeJS.ProcessEnv {
	const preferences = validateDesktopEnvironmentPreferences({ version: 1, extraExecutableDirectories: directories });
	if (!isAbsolute(nodePath) || /[\0\r\n]/u.test(nodePath)) throw new DesktopEnvironmentPreferencesError();
	const paths = [
		dirname(nodePath),
		...preferences.extraExecutableDirectories,
		...(environment.PATH ?? "").split(delimiter),
	];
	return {
		...environment,
		PATH: [
			...new Set(paths.filter((path) => isAbsolute(path) && !/[\0\r\n]/u.test(path)).map((path) => normalize(path))),
		].join(delimiter),
	};
}
