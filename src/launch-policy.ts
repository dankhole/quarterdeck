export interface LaunchEnvironment {
	platform: string;
	arch: string;
	/** Native kernel release (macOS 13 starts at Darwin 22; Windows 10 at NT 10). */
	osRelease: string;
	graphicalSession: boolean;
	desktopHelper: boolean;
	/** Explicitly isolated lab execution or a source checkout, never a public launch default. */
	internalRuntimeAllowed: boolean;
}

export interface LaunchOptions {
	desktop?: boolean;
	internalRuntime?: boolean;
	runtimeFlags: boolean;
}

export interface LaunchPolicy {
	mode: "desktop" | "runtime";
}

/** This matches the native package's macOS 13 floor without loading desktop tooling. */
export function supportsDesktopHost(environment: Pick<LaunchEnvironment, "platform" | "arch" | "osRelease">): boolean {
	if (!["arm64", "x64"].includes(environment.arch)) return false;
	const major = Number.parseInt(environment.osRelease.split(".")[0] ?? "", 10);
	return (environment.platform === "darwin" && major >= 22) || (environment.platform === "win32" && major >= 10);
}

/** Internal CLI runtimes serve only local authenticated desktop/test clients, never remote or browser clients. */
export function resolveInternalRuntimeHost(host: string | null | undefined): "127.0.0.1" {
	if (host?.trim() && host.trim() !== "127.0.0.1") {
		throw new Error(
			"Internal runtimes bind only to 127.0.0.1; wildcard, remote, and hostname binds are not supported.",
		);
	}
	return "127.0.0.1";
}

/** Subcommands bypass this policy; their parsing and effects belong to their command owners. */
export function resolveLaunchPolicy(options: LaunchOptions, environment: LaunchEnvironment): LaunchPolicy {
	if (options.internalRuntime) {
		if (options.desktop) throw new Error("--desktop cannot be combined with internal runtime options.");
		if (!environment.desktopHelper && !environment.internalRuntimeAllowed) {
			throw new Error(
				"Internal runtime execution is restricted to desktop helpers, Agent Lab, and source development.",
			);
		}
		return { mode: "runtime" };
	}
	if (environment.desktopHelper)
		throw new Error("A desktop runtime helper requires --internal-runtime and cannot launch another desktop app.");
	if (options.runtimeFlags)
		throw new Error("Runtime options require an explicitly authorized --internal-runtime invocation.");
	if (!supportsDesktopHost(environment)) {
		throw new Error(
			"Quarterdeck requires the desktop app on macOS 13+ or Windows 10+ on arm64 or x64. Standalone browser and headless product access are not supported.",
		);
	}
	if (!environment.graphicalSession) {
		throw new Error(
			"Quarterdeck requires a local graphical session. Open the installed desktop app from your macOS or Windows desktop session.",
		);
	}
	return { mode: "desktop" };
}
