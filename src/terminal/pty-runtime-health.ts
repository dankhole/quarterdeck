import { accessSync, constants, statSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";

import { isBinaryAvailableOnPath } from "../core";

const require = createRequire(import.meta.url);

export const PTY_RUNTIME_REMEDIATION =
	"Quarterdeck’s terminal launcher is unavailable because an installed runtime dependency is missing. Dependencies may have been reinstalled or removed while Quarterdeck was running. Restore the Quarterdeck dependencies and restart Quarterdeck. For a linked development checkout, run `npm ci`, `npm ci --prefix web-ui`, and `npm run link`, then restart Quarterdeck.";

export type PtyRuntimeHealthIssue = "package_missing" | "native_module_missing" | "spawn_helper_missing";

export interface PtyRuntimeHealth {
	available: boolean;
	platform: NodeJS.Platform;
	arch: string;
	issue: PtyRuntimeHealthIssue | null;
	nativeModuleAvailable: boolean;
	spawnHelperRequired: boolean;
	spawnHelperAvailable: boolean | null;
}

interface InspectPtyRuntimeHealthOptions {
	packageRoot?: string;
	platform?: NodeJS.Platform;
	arch?: string;
}

function isAccessibleFile(path: string, mode: number): boolean {
	try {
		if (!statSync(path).isFile()) {
			return false;
		}
		accessSync(path, mode);
		return true;
	} catch {
		return false;
	}
}

function resolveNodePtyPackageRoot(): string | null {
	try {
		return dirname(require.resolve("node-pty/package.json"));
	} catch {
		return null;
	}
}

function getNativeAssetDirectories(packageRoot: string, platform: NodeJS.Platform, arch: string): string[] {
	const relativeDirectories = ["build/Release", "build/Debug", `prebuilds/${platform}-${arch}`];
	return relativeDirectories.flatMap((relativeDirectory) => [
		join(packageRoot, relativeDirectory),
		join(packageRoot, "lib", relativeDirectory),
	]);
}

export function inspectPtyRuntimeHealth(options: InspectPtyRuntimeHealthOptions = {}): PtyRuntimeHealth {
	const platform = options.platform ?? process.platform;
	const arch = options.arch ?? process.arch;
	const packageRoot = options.packageRoot ?? resolveNodePtyPackageRoot();
	const spawnHelperRequired = platform === "darwin";
	if (!packageRoot) {
		return {
			available: false,
			platform,
			arch,
			issue: "package_missing",
			nativeModuleAvailable: false,
			spawnHelperRequired,
			spawnHelperAvailable: spawnHelperRequired ? false : null,
		};
	}

	const nativeModuleName = platform === "win32" ? "conpty.node" : "pty.node";
	const nativeDirectory = getNativeAssetDirectories(packageRoot, platform, arch).find((directory) =>
		isAccessibleFile(join(directory, nativeModuleName), constants.F_OK),
	);
	if (!nativeDirectory) {
		return {
			available: false,
			platform,
			arch,
			issue: "native_module_missing",
			nativeModuleAvailable: false,
			spawnHelperRequired,
			spawnHelperAvailable: spawnHelperRequired ? false : null,
		};
	}

	const spawnHelperAvailable = spawnHelperRequired
		? isAccessibleFile(join(nativeDirectory, "spawn-helper"), constants.X_OK)
		: null;
	return {
		available: !spawnHelperRequired || spawnHelperAvailable === true,
		platform,
		arch,
		issue: spawnHelperRequired && !spawnHelperAvailable ? "spawn_helper_missing" : null,
		nativeModuleAvailable: true,
		spawnHelperRequired,
		spawnHelperAvailable,
	};
}

export type PtyLaunchErrorCode = "cwd_missing" | "command_missing" | "runtime_dependency_missing" | "spawn_failed";

export class PtyLaunchError extends Error {
	constructor(
		readonly code: PtyLaunchErrorCode,
		message: string,
		options?: ErrorOptions,
	) {
		super(message, options);
		this.name = "PtyLaunchError";
	}
}

export class PtyLaunchCwdError extends PtyLaunchError {
	constructor() {
		super(
			"cwd_missing",
			"The terminal launch directory does not exist or is not a directory. The task worktree may have been removed; restore or recreate it, then try again.",
		);
		this.name = "PtyLaunchCwdError";
	}
}

export class PtyLaunchCommandError extends PtyLaunchError {
	constructor(binary: string) {
		super(
			"command_missing",
			`The terminal command "${binary}" is not executable in Quarterdeck’s launch environment. Install or repair that command, then restart Quarterdeck so it inherits the updated PATH.`,
		);
		this.name = "PtyLaunchCommandError";
	}
}

export class PtyRuntimeDependencyError extends PtyLaunchError {
	constructor(readonly health: PtyRuntimeHealth) {
		super("runtime_dependency_missing", PTY_RUNTIME_REMEDIATION);
		this.name = "PtyRuntimeDependencyError";
	}
}

export class PtySpawnError extends PtyLaunchError {
	readonly underlyingErrorClass: string;

	constructor(error: unknown) {
		const underlyingError = error instanceof Error ? error : new Error(String(error));
		super(
			"spawn_failed",
			`The terminal process could not be started (${underlyingError.name}: ${underlyingError.message}).`,
			{ cause: underlyingError },
		);
		this.name = "PtySpawnError";
		this.underlyingErrorClass = underlyingError.name;
	}
}

export function assertPtyRuntimeAvailable(health = inspectPtyRuntimeHealth()): void {
	if (!health.available) {
		throw new PtyRuntimeDependencyError(health);
	}
}

export function preflightPtyLaunch(options: {
	binary: string;
	cwd: string;
	env: NodeJS.ProcessEnv;
	platform?: NodeJS.Platform;
	runtimeHealth?: PtyRuntimeHealth;
}): void {
	try {
		if (!statSync(options.cwd).isDirectory()) {
			throw new PtyLaunchCwdError();
		}
	} catch (error) {
		if (error instanceof PtyLaunchCwdError) {
			throw error;
		}
		throw new PtyLaunchCwdError();
	}

	assertPtyRuntimeAvailable(options.runtimeHealth);
	if (!isBinaryAvailableOnPath(options.binary, { env: options.env, platform: options.platform })) {
		throw new PtyLaunchCommandError(options.binary);
	}
}

export function classifyPtySpawnFailure(
	error: unknown,
	options: {
		binary: string;
		cwd: string;
		env: NodeJS.ProcessEnv;
		platform?: NodeJS.Platform;
		runtimeHealth?: PtyRuntimeHealth;
	},
): PtyLaunchError {
	if (error instanceof PtyLaunchError) {
		return error;
	}
	try {
		preflightPtyLaunch(options);
	} catch (preflightError) {
		if (preflightError instanceof PtyLaunchError) {
			return preflightError;
		}
	}
	return new PtySpawnError(error);
}
