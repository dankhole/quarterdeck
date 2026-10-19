export type DesktopInstallationErrorCode =
	| "unsupported_platform"
	| "invalid_version"
	| "release_unavailable"
	| "download_failed"
	| "invalid_artifact"
	| "installation_changed"
	| "installation_in_use"
	| "owner_conflict"
	| "incomplete_installation"
	| "command_failed";

export class DesktopInstallationError extends Error {
	constructor(
		readonly code: DesktopInstallationErrorCode,
		message: string,
	) {
		super(message);
		this.name = "DesktopInstallationError";
	}
}
