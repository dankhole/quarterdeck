export type DesktopInstallationArchitecture = "arm64" | "x64";

export interface DesktopInstallationProgress {
	phase: "resolving" | "downloading" | "verifying" | "copying" | "installed";
	message: string;
}

export interface EnsureDesktopInstallationOptions {
	version: string;
	from?: string;
	onProgress?: (progress: DesktopInstallationProgress) => void;
}

export interface DesktopInstallation {
	appPath: string;
	version: string;
	arch: DesktopInstallationArchitecture;
	source: "release" | "local";
	installId: string;
	buildId: string;
	appAsarSha256: string;
	receiptPath: string;
}

export interface DesktopInstallCommandResult {
	stdout: string;
	stderr: string;
}

/** Internal effect boundaries; callers cannot redirect the production install root. */
export interface DesktopInstallationDependencies {
	platform: NodeJS.Platform;
	arch: string;
	managedRoot: string;
	runCommand: (command: string, args: readonly string[]) => Promise<DesktopInstallCommandResult>;
	download: (url: string, destination: string, maximumBytes: number) => Promise<void>;
}
