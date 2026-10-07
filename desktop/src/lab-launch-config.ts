import { lstatSync, readFileSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";

export interface DesktopLabLaunchConfig {
	version: 1;
	tempRoot: string;
	stateHome: string;
	userDataPath: string;
	projectPath: string;
	hostSimulationConfigPath: string;
	processEvidencePath: string;
	showWindow: boolean;
}

function within(parent: string, child: string): boolean {
	const rel = relative(parent, child);
	return rel.length > 0 && rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
}

function isPlatformTemporaryRoot(path: string): boolean {
	// Agent Lab overrides TMPDIR to its root; use platform roots independent of that override.
	if (within(realpathSync("/tmp"), path)) return true;
	return process.platform === "darwin" && /^\/private\/var\/folders\/[^/]+\/[^/]+\/T\/.+/.test(path);
}

export function readLabLaunchConfig(configPath: string | undefined): DesktopLabLaunchConfig {
	if (!configPath || !isAbsolute(configPath))
		throw new Error("Desktop prototype requires an isolated Agent Lab launch configuration.");
	const configFile = realpathSync(configPath);
	const stat = lstatSync(configFile);
	if (!stat.isFile() || stat.size > 16_384 || (stat.mode & 0o077) !== 0)
		throw new Error("Agent Lab configuration must be a small private file.");
	const value: unknown = JSON.parse(readFileSync(configFile, "utf8"));
	if (!value || typeof value !== "object" || Array.isArray(value))
		throw new Error("Invalid Agent Lab launch configuration.");
	const record = value as Record<string, unknown>;
	const keys = [
		"version",
		"tempRoot",
		"stateHome",
		"userDataPath",
		"projectPath",
		"hostSimulationConfigPath",
		"processEvidencePath",
	];
	if (
		Object.keys(record).some((key) => !keys.includes(key) && key !== "showWindow") ||
		record.version !== 1 ||
		(record.showWindow !== undefined && typeof record.showWindow !== "boolean")
	)
		throw new Error("Unsupported Agent Lab launch configuration.");
	for (const key of keys.slice(1)) {
		if (typeof record[key] !== "string" || !isAbsolute(record[key]))
			throw new Error("Agent Lab paths must be absolute.");
	}
	const input = record as unknown as DesktopLabLaunchConfig;
	const tempRoot = realpathSync(input.tempRoot);
	if (!isPlatformTemporaryRoot(tempRoot) || !within(tempRoot, configFile))
		throw new Error("Agent Lab launch must remain within its temporary root.");
	const canonical = (path: string): string => {
		const result = realpathSync(path);
		if (!within(tempRoot, result)) throw new Error("Agent Lab path escapes its temporary root.");
		return result;
	};
	const stateHome = canonical(input.stateHome);
	const userDataPath = canonical(input.userDataPath);
	if (stateHome === userDataPath || within(stateHome, userDataPath) || within(userDataPath, stateHome))
		throw new Error("Runtime and Electron storage must be separate.");
	const evidenceParent = realpathSync(dirname(input.processEvidencePath));
	if (evidenceParent !== tempRoot && !within(tempRoot, evidenceParent))
		throw new Error("Agent Lab evidence escapes its temporary root.");
	const evidencePath = resolve(
		evidenceParent,
		relative(dirname(input.processEvidencePath), input.processEvidencePath),
	);
	try {
		if (lstatSync(evidencePath).isSymbolicLink()) throw new Error("Agent Lab evidence cannot be a symbolic link.");
	} catch (error) {
		if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
	}
	return {
		version: 1,
		tempRoot,
		stateHome,
		userDataPath,
		projectPath: canonical(input.projectPath),
		hostSimulationConfigPath: canonical(input.hostSimulationConfigPath),
		processEvidencePath: evidencePath,
		showWindow: record.showWindow === true,
	};
}
