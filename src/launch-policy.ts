export interface LaunchEnvironment {
	platform: string;
	arch: string;
	/** Darwin kernel release (macOS 13 starts at Darwin 22). */
	osRelease: string;
	graphicalSession: boolean;
	desktopHelper: boolean;
}

export interface LaunchOptions {
	desktop?: boolean;
	browser?: boolean;
	runtimeFlags: boolean;
	noOpen: boolean;
}

export interface LaunchPolicy {
	mode: "desktop" | "runtime";
	openBrowser: boolean;
}

/** This matches the native package's macOS 13 floor without loading desktop tooling. */
export function supportsDesktopHost(environment: Pick<LaunchEnvironment, "platform" | "arch" | "osRelease">): boolean {
	return (
		environment.platform === "darwin" &&
		(environment.arch === "arm64" || environment.arch === "x64") &&
		Number.parseInt(environment.osRelease.split(".")[0] ?? "", 10) >= 22
	);
}

/** Subcommands bypass this policy; their parsing and effects belong to their command owners. */
export function resolveLaunchPolicy(options: LaunchOptions, environment: LaunchEnvironment): LaunchPolicy {
	if (options.desktop) {
		if (environment.desktopHelper) throw new Error("A desktop runtime helper cannot launch another desktop app.");
		if (!supportsDesktopHost(environment)) {
			throw new Error("Desktop mode requires macOS 13 or newer on arm64 or x64. Use quarterdeck --browser.");
		}
		if (!environment.graphicalSession) {
			throw new Error("Desktop mode requires a local macOS graphical session. Use quarterdeck --browser --no-open.");
		}
		if (options.browser || options.runtimeFlags || options.noOpen) {
			throw new Error("--desktop cannot be combined with browser or runtime options.");
		}
		return { mode: "desktop", openBrowser: false };
	}
	if (
		!environment.desktopHelper &&
		!options.browser &&
		!options.runtimeFlags &&
		!options.noOpen &&
		supportsDesktopHost(environment) &&
		environment.graphicalSession
	) {
		return { mode: "desktop", openBrowser: false };
	}
	return {
		mode: "runtime",
		openBrowser:
			!options.noOpen &&
			!environment.desktopHelper &&
			(environment.platform !== "darwin" || environment.graphicalSession),
	};
}
