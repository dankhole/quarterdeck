import type {
	IRuntimeHostIntegrations,
	RuntimeCapabilities,
	RuntimeHostActionContext,
	RuntimeOpenTargetId,
} from "../core";
import { openTargetOnHost } from "./browser";
import { pickDirectoryPathFromSystemDialog, type SystemDirectoryPickerResult } from "./directory-picker";
import { openProjectOnHost, type SystemOpenProjectResult } from "./open-project";

export type RuntimeHostIntegrationKind = "directory_picker" | "external_url" | "open_path" | "open_project";

export interface RuntimeHostIntegrationAttempt {
	kind: RuntimeHostIntegrationKind;
	blocked: boolean;
	mode: RuntimeCapabilities["hostIntegrationMode"];
}

export interface RuntimeHostIntegrationSimulator {
	recordUnsupportedDirectoryPicker: () => Promise<void>;
	openPath: (targetPath: string, context?: RuntimeHostActionContext) => Promise<{ ok: true } | { ok: false }>;
	openExternalUrl: (url: string, context?: RuntimeHostActionContext) => Promise<{ ok: true } | { ok: false }>;
	openProject: (
		targetId: RuntimeOpenTargetId,
		cwd: string,
		context?: RuntimeHostActionContext,
	) => Promise<{ ok: true } | { ok: false }>;
}

export interface CreateRuntimeHostIntegrationsOptions {
	capabilities: RuntimeCapabilities;
	warn?: (message: string) => void;
	onAttempt?: (attempt: RuntimeHostIntegrationAttempt) => void;
	pickDirectory?: () => Promise<SystemDirectoryPickerResult>;
	openTarget?: (target: string) => Promise<void>;
	openProject?: (targetId: RuntimeOpenTargetId, cwd: string) => Promise<SystemOpenProjectResult>;
	simulator?: RuntimeHostIntegrationSimulator;
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

	const beginAttempt = (kind: RuntimeHostIntegrationKind): RuntimeCapabilities["hostIntegrationMode"] => {
		const mode = capabilities.hostIntegrationMode;
		const blocked = mode === "unavailable" || (mode === "simulated" && !options.simulator);
		options.onAttempt?.({ kind, blocked, mode });
		if (mode === "unavailable") {
			warn(`[host-integration] Blocked ${kind}: native UI is disabled by launch configuration.`);
		} else if (mode === "simulated" && !options.simulator) {
			warn(`[host-integration] Blocked ${kind}: simulated host integrations are not configured.`);
		}
		return blocked ? "unavailable" : mode;
	};

	return {
		capabilities,
		async pickDirectory() {
			const mode = beginAttempt("directory_picker");
			if (mode === "simulated") {
				try {
					await options.simulator?.recordUnsupportedDirectoryPicker();
					return {
						ok: false,
						path: null,
						reason: "native_ui_unavailable",
						error: "Agent Lab uses browser-managed manual path entry instead of a native directory picker.",
					} as const;
				} catch (error) {
					const message = toErrorMessage(error);
					warn(`[host-integration] Could not record simulated directory picker: ${message}`);
					return { ok: false, path: null, reason: "launch_failed", error: message } as const;
				}
			}
			if (mode === "unavailable") {
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
					return { ok: true, path: result.path, outcome: "native" };
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
		async openPath(targetPath, context) {
			const mode = beginAttempt("open_path");
			if (mode === "simulated") {
				try {
					const simulated = await options.simulator?.openPath(targetPath, context);
					return simulated?.ok
						? { ok: true, outcome: "simulated" }
						: {
								ok: false,
								reason: "invalid_target",
								error: "Host path is outside the simulated runtime scopes.",
							};
				} catch (error) {
					const message = toErrorMessage(error);
					warn(`[host-integration] Could not record simulated host path: ${message}`);
					return { ok: false, reason: "launch_failed", error: message };
				}
			}
			if (mode === "unavailable") {
				return {
					ok: false,
					reason: "native_ui_unavailable",
					error: NATIVE_UI_UNAVAILABLE_MESSAGE,
				};
			}
			try {
				await openTarget(targetPath);
				return { ok: true, outcome: "native" };
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
		async openExternalUrl(url, context) {
			const mode = beginAttempt("external_url");
			if (mode === "simulated") {
				try {
					const simulated = await options.simulator?.openExternalUrl(url, context);
					return simulated?.ok
						? { ok: true, outcome: "simulated" }
						: { ok: false, reason: "invalid_target", error: "External URL is not safe to simulate." };
				} catch (error) {
					const message = toErrorMessage(error);
					warn(`[host-integration] Could not record simulated external URL: ${message}`);
					return { ok: false, reason: "launch_failed", error: message };
				}
			}
			if (mode === "unavailable") {
				return {
					ok: false,
					reason: "native_ui_unavailable",
					error: NATIVE_UI_UNAVAILABLE_MESSAGE,
				};
			}
			try {
				await openTarget(url);
				return { ok: true, outcome: "native" };
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
		async openProject(targetId, cwd, context) {
			const mode = beginAttempt("open_project");
			if (mode === "simulated") {
				try {
					const simulated = await options.simulator?.openProject(targetId, cwd, context);
					return simulated?.ok
						? { ok: true, outcome: "simulated" }
						: {
								ok: false,
								reason: "invalid_target",
								error: "Project path is outside the simulated runtime scopes.",
							};
				} catch (error) {
					const message = toErrorMessage(error);
					warn(`[host-integration] Could not record simulated project open: ${message}`);
					return { ok: false, reason: "launch_failed", error: message };
				}
			}
			if (mode === "unavailable") {
				return {
					ok: false,
					reason: "native_ui_unavailable",
					error: NATIVE_UI_UNAVAILABLE_MESSAGE,
				};
			}
			try {
				const result = await launchProject(targetId, cwd);
				if (result.kind === "opened") {
					return { ok: true, outcome: "native" };
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
