import type { IRuntimeHostIntegrations, RuntimeCapabilities, RuntimeOpenTargetId } from "../core";
import { openTargetOnHost } from "./browser";
import { pickDirectoryPathFromSystemDialog, type SystemDirectoryPickerResult } from "./directory-picker";
import { openProjectOnHost, type SystemOpenProjectResult } from "./open-project";

export type RuntimeHostIntegrationKind = "directory_picker" | "external_url" | "open_path" | "open_project";

export interface RuntimeHostIntegrationAttempt {
	kind: RuntimeHostIntegrationKind;
	blocked: boolean;
}

export interface CreateRuntimeHostIntegrationsOptions {
	capabilities: RuntimeCapabilities;
	warn?: (message: string) => void;
	onAttempt?: (attempt: RuntimeHostIntegrationAttempt) => void;
	pickDirectory?: () => Promise<SystemDirectoryPickerResult>;
	openTarget?: (target: string) => Promise<void>;
	openProject?: (targetId: RuntimeOpenTargetId, cwd: string) => Promise<SystemOpenProjectResult>;
}

const NATIVE_UI_UNAVAILABLE_MESSAGE = "Native UI is unavailable for this Quarterdeck runtime.";

function toErrorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function failureReasonForError(error: unknown): "launcher_unavailable" | "launch_failed" {
	if (error && typeof error === "object" && "code" in error && (error as NodeJS.ErrnoException).code === "ENOENT") {
		return "launcher_unavailable";
	}
	return "launch_failed";
}

export function createRuntimeHostIntegrations(options: CreateRuntimeHostIntegrationsOptions): IRuntimeHostIntegrations {
	const capabilities = Object.freeze({ ...options.capabilities });
	const warn = options.warn ?? (() => {});
	const pickDirectory = options.pickDirectory ?? pickDirectoryPathFromSystemDialog;
	const openTarget = options.openTarget ?? openTargetOnHost;
	const launchProject = options.openProject ?? openProjectOnHost;

	const beginAttempt = (kind: RuntimeHostIntegrationKind): boolean => {
		const blocked = !capabilities.nativeUiAvailable;
		options.onAttempt?.({ kind, blocked });
		if (blocked) {
			warn(`[host-integration] Blocked ${kind}: native UI is disabled by launch configuration.`);
		}
		return !blocked;
	};

	return {
		capabilities,
		async pickDirectory() {
			if (!beginAttempt("directory_picker")) {
				return {
					ok: false,
					path: null,
					reason: "native_ui_unavailable",
					error: NATIVE_UI_UNAVAILABLE_MESSAGE,
				};
			}
			try {
				const result = await pickDirectory();
				if (result.kind === "selected") {
					return { ok: true, path: result.path };
				}
				if (result.kind === "cancelled") {
					return {
						ok: false,
						path: null,
						reason: "cancelled",
						error: "No directory was selected.",
					};
				}
				warn(`[host-integration] Directory picker unavailable: ${result.error}`);
				return {
					ok: false,
					path: null,
					reason: "launcher_unavailable",
					error: result.error,
				};
			} catch (error) {
				const message = toErrorMessage(error);
				warn(`[host-integration] Directory picker failed: ${message}`);
				return {
					ok: false,
					path: null,
					reason: "launch_failed",
					error: message,
				};
			}
		},
		async openPath(targetPath) {
			if (!beginAttempt("open_path")) {
				return {
					ok: false,
					reason: "native_ui_unavailable",
					error: NATIVE_UI_UNAVAILABLE_MESSAGE,
				};
			}
			try {
				await openTarget(targetPath);
				return { ok: true };
			} catch (error) {
				const message = toErrorMessage(error);
				warn(`[host-integration] Could not open host path: ${message}`);
				return {
					ok: false,
					reason: failureReasonForError(error),
					error: message,
				};
			}
		},
		async openExternalUrl(url) {
			if (!beginAttempt("external_url")) {
				return {
					ok: false,
					reason: "native_ui_unavailable",
					error: NATIVE_UI_UNAVAILABLE_MESSAGE,
				};
			}
			try {
				await openTarget(url);
				return { ok: true };
			} catch (error) {
				const message = toErrorMessage(error);
				warn(`[host-integration] Could not open external URL: ${message}`);
				return {
					ok: false,
					reason: failureReasonForError(error),
					error: message,
				};
			}
		},
		async openProject(targetId, cwd) {
			if (!beginAttempt("open_project")) {
				return {
					ok: false,
					reason: "native_ui_unavailable",
					error: NATIVE_UI_UNAVAILABLE_MESSAGE,
				};
			}
			try {
				const result = await launchProject(targetId, cwd);
				if (result.kind === "opened") {
					return { ok: true };
				}
				warn(`[host-integration] Could not open project with ${targetId}: ${result.error}`);
				return {
					ok: false,
					reason: result.kind === "unavailable" ? "launcher_unavailable" : "launch_failed",
					error: result.error,
				};
			} catch (error) {
				const message = toErrorMessage(error);
				warn(`[host-integration] Could not open project with ${targetId}: ${message}`);
				return {
					ok: false,
					reason: "launch_failed",
					error: message,
				};
			}
		},
	};
}
