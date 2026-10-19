import type { DesktopInstallationOwner } from "../shared/desktop-installation-contract.js";

export type DesktopInstallationArchitecture = "arm64" | "x64";

export interface DesktopInstallationProgress {
	phase: "resolving" | "downloading" | "verifying" | "copying" | "installed";
	message: string;
}

export interface EnsureDesktopInstallationOptions {
	version: string;
	from?: string;
	owner?: DesktopInstallationOwner;
	replaceOwner?: boolean;
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
	owner: DesktopInstallationOwner;
	cleanupPending: boolean;
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
	stageIdentity?: { host: string; process: { pid: number; creationIdentity: string } };
	appPath?: string;
	owner?: DesktopInstallationOwner;
	/** Test boundary; production acquires a kernel lock using the verified native bootstrap. */
	acquireMutation?: (bootstrap: string, lockPath: string) => Promise<() => Promise<void>>;
	/** Deterministic filesystem interruption tests; production does not supply this observer. */
	checkpoint?: (
		phase: "backed_up" | "promoted" | "metadata_written" | "receipt_committed" | "cleanup_authorized",
	) => Promise<void>;
	runCommand: (command: string, args: readonly string[]) => Promise<DesktopInstallCommandResult>;
	download: (url: string, destination: string, maximumBytes: number) => Promise<void>;
}
