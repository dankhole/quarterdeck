export interface LaunchEnvironment {
	platform: string;
	arch: string;
	/** Native kernel release (macOS 13 starts at Darwin 22; Windows 10 at NT 10). */
	osRelease: string;
	graphicalSession: boolean;
	desktopHelper: boolean;
	/** A desktop-capable global npm package, without an installation-scoped browser opt-out. */
	desktopDefault: boolean;
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
	if (!["arm64", "x64"].includes(environment.arch)) return false;
	const major = Number.parseInt(environment.osRelease.split(".")[0] ?? "", 10);
	return (environment.platform === "darwin" && major >= 22) || (environment.platform === "win32" && major >= 10);
}

/** Subcommands bypass this policy; their parsing and effects belong to their command owners. */
export function resolveLaunchPolicy(options: LaunchOptions, environment: LaunchEnvironment): LaunchPolicy {
	if (options.desktop) {
		if (environment.desktopHelper) throw new Error("A desktop runtime helper cannot launch another desktop app.");
		if (!supportsDesktopHost(environment)) {
			throw new Error("Desktop mode requires macOS 13+ or Windows 10+ on arm64 or x64. Use quarterdeck --browser.");
		}
		if (!environment.graphicalSession) {
			throw new Error("Desktop mode requires a local graphical session. Use quarterdeck --browser --no-open.");
		}
		if (options.browser || options.runtimeFlags || options.noOpen) {
			throw new Error("--desktop cannot be combined with browser or runtime options.");
		}
		return { mode: "desktop", openBrowser: false };
	}
	if (
		environment.desktopDefault &&
		supportsDesktopHost(environment) &&
		environment.graphicalSession &&
		!environment.desktopHelper &&
		!options.browser &&
		!options.runtimeFlags &&
		!options.noOpen
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
