import type { MessageBoxOptions, OpenDialogOptions } from "electron";
import {
	type DesktopEnvironmentIntent,
	type DesktopEnvironmentResponse,
	type DesktopEnvironmentSnapshot,
	desktopEnvironmentIntentSchema,
} from "../../src/shared/desktop-environment-contract.js";
import {
	type DesktopEnvironmentPreferences,
	readDesktopEnvironmentPreferences,
	writeDesktopEnvironmentPreferences,
} from "./environment-preferences.js";
import type { DesktopEnvironmentFailureReason } from "./launch-environment.js";

export interface DesktopEnvironmentStatus {
	ownership: "owned" | "attached" | "none";
	source: "inherited" | "login-shell" | "fallback" | "unresolved";
	failureReason?: DesktopEnvironmentFailureReason;
	appliedDirectories: readonly string[];
	appliedImportLoginShellEnvironment?: boolean;
}

export type DesktopEnvironmentRefreshResult = "refreshed" | "cancelled" | "incomplete" | "failed";

export interface DesktopEnvironmentControllerOptions {
	userDataPath: string;
	getStatus: () => DesktopEnvironmentStatus;
	showMessage: (options: MessageBoxOptions) => Promise<number>;
	showFolders: (options: OpenDialogOptions) => Promise<string[] | null>;
	/** Main owns sealed draft preflight, live-session confirmation, confirmed shutdown, and restart. */
	requestRefresh: () => Promise<DesktopEnvironmentRefreshResult>;
	canMutate?: () => boolean;
}

const FAILURE_GUIDANCE: Record<DesktopEnvironmentFailureReason, string> = {
	unsupported_shell: "The login shell is unsupported. Add the folder containing your agent or Git executable.",
	capture_failed:
		"The login shell could not provide its environment. Check your shell setup or add executable folders.",
	capture_timeout: "Reading the login shell timed out. Remove interactive startup prompts or add executable folders.",
	capture_output_limit:
		"The login shell returned too much environment data. Check your shell setup or add executable folders.",
	capture_invalid:
		"The login shell returned an invalid environment. Check your shell setup or add executable folders.",
};

/** Native-only setup. Renderer IPC never supplies executable folders or arbitrary commands. */
export class DesktopEnvironmentController {
	private active: Promise<void> | null = null;
	private mutation: Promise<unknown> = Promise.resolve();
	constructor(private readonly options: DesktopEnvironmentControllerOptions) {}

	async getSnapshot(): Promise<DesktopEnvironmentSnapshot> {
		let preferences: DesktopEnvironmentSnapshot["preferences"] = null;
		try {
			const saved = await readDesktopEnvironmentPreferences(this.options.userDataPath);
			preferences = {
				importLoginShellEnvironment: saved.importLoginShellEnvironment,
				extraExecutableDirectories: saved.extraExecutableDirectories,
			};
		} catch {
			// Unreadable preferences require an explicit recovery intent, never a silent overwrite.
		}
		const status = this.options.getStatus();
		return {
			ownership: status.ownership,
			source: status.source,
			failureReason: status.failureReason ?? null,
			appliedDirectories: [...status.appliedDirectories],
			appliedImportLoginShellEnvironment: status.appliedImportLoginShellEnvironment ?? null,
			preferences,
		};
	}

	request(
		intent: DesktopEnvironmentIntent,
		isAdmitted: () => boolean = () => true,
	): Promise<DesktopEnvironmentResponse> {
		const pending = this.mutation.then(async (): Promise<DesktopEnvironmentResponse> => {
			const allowed = () =>
				isAdmitted() &&
				!this.active &&
				this.options.getStatus().ownership !== "attached" &&
				(this.options.canMutate?.() ?? true);
			const respond = async (
				outcome: DesktopEnvironmentResponse["outcome"],
			): Promise<DesktopEnvironmentResponse> => ({
				outcome,
				snapshot: isAdmitted() ? await this.getSnapshot() : null,
			});
			const parsed = desktopEnvironmentIntentSchema.safeParse(intent);
			if (!parsed.success || !allowed()) return respond("unavailable");
			try {
				if (parsed.data.kind === "refresh") return respond(await this.options.requestRefresh());
				let preferences: DesktopEnvironmentPreferences;
				if (parsed.data.kind === "reset-preferences") {
					preferences = { version: 1, extraExecutableDirectories: [], importLoginShellEnvironment: false };
				} else {
					preferences = await readDesktopEnvironmentPreferences(this.options.userDataPath);
					if (!allowed()) return respond("unavailable");
					if (parsed.data.kind === "set-login-shell-import") {
						preferences.importLoginShellEnvironment = parsed.data.enabled;
					} else if (parsed.data.kind === "reset-folders") {
						preferences.extraExecutableDirectories = [];
					} else {
						const folders = await this.options.showFolders({
							title: "Choose executable folders",
							buttonLabel: "Add Folders",
							properties: ["openDirectory", "multiSelections"],
						});
						if (!allowed()) return respond("unavailable");
						if (!folders) return respond("cancelled");
						preferences.extraExecutableDirectories.push(...folders);
					}
				}
				if (!allowed()) return respond("unavailable");
				await writeDesktopEnvironmentPreferences(this.options.userDataPath, preferences);
				return respond("saved");
			} catch {
				return respond("failed");
			}
		});
		this.mutation = pending.catch(() => undefined);
		return pending;
	}

	open(): Promise<void> {
		if (this.active) return this.active;
		const action = this.mutation
			.then(() => this.present())
			.finally(() => {
				this.active = null;
			});
		this.active = action;
		return action;
	}

	private async attached(): Promise<boolean> {
		if (this.options.getStatus().ownership !== "attached") return false;
		await this.options.showMessage({
			type: "info",
			title: "Runtime Environment",
			buttons: ["Close"],
			defaultId: 0,
			cancelId: 0,
			message: "This runtime belongs to the CLI",
			detail:
				"Executable discovery uses the environment of the running Quarterdeck CLI. Change that shell environment and restart its runtime. The app cannot change or refresh a CLI-owned runtime.",
		});
		return true;
	}

	private async present(): Promise<void> {
		for (;;) {
			if (await this.attached()) return;
			let preferences: DesktopEnvironmentPreferences;
			try {
				preferences = await readDesktopEnvironmentPreferences(this.options.userDataPath);
			} catch {
				const choice = await this.options.showMessage({
					type: "warning",
					title: "Runtime Environment",
					buttons: ["Close", "Reset Saved Settings"],
					defaultId: 0,
					cancelId: 0,
					message: "Saved environment settings could not be read",
					detail:
						"Reset the saved folders and disable login-shell import to continue setup. Your running runtime's environment stays in effect until Refresh Environment completes.",
				});
				if (choice !== 1 || (await this.attached())) return;
				if (
					!(await this.save({
						version: 1,
						extraExecutableDirectories: [],
						importLoginShellEnvironment: false,
					}))
				)
					return;
				continue;
			}
			if (await this.attached()) return;
			const status = this.options.getStatus();
			const source = {
				inherited: "Inherited from app launch",
				"login-shell": "Login shell",
				fallback: "Inherited fallback",
				unresolved: "Not resolved yet",
			}[status.source];
			const changed =
				JSON.stringify(status.appliedDirectories) !== JSON.stringify(preferences.extraExecutableDirectories) ||
				status.appliedImportLoginShellEnvironment !== preferences.importLoginShellEnvironment;
			const choice = await this.options.showMessage({
				type: status.failureReason ? "warning" : "info",
				title: "Runtime Environment",
				message: "Runtime environment settings",
				buttons: [
					"Close",
					"Add Folders…",
					"Reset Override",
					"Refresh Environment",
					preferences.importLoginShellEnvironment ? "Disable Login-Shell Import" : "Enable Login-Shell Import",
				],
				defaultId: 0,
				cancelId: 0,
				detail: [
					`Environment source: ${source}.`,
					`Current login-shell import: ${status.appliedImportLoginShellEnvironment === undefined ? "Not applied yet" : status.appliedImportLoginShellEnvironment ? "Enabled" : "Disabled"}.`,
					`Saved login-shell import: ${preferences.importLoginShellEnvironment ? "Enabled" : "Disabled"}.`,
					status.failureReason
						? FAILURE_GUIDANCE[status.failureReason]
						: "Git and task agents are installed separately from Quarterdeck.",
					`Extra executable folders:\n${preferences.extraExecutableDirectories.join("\n") || "None"}`,
					changed
						? "Saved settings have unapplied changes."
						: "Saved settings match the current app configuration.",
					"Folders take precedence over discovered executables; bundled Node remains first. Refresh Environment applies saved settings and safely restarts an app-owned runtime after protecting drafts and confirming live sessions.",
					"Login-shell import is enabled by default and can be disabled. When enabled, app startup and Refresh Environment run shell startup files, which can run commands and access Keychain. Exported environment values stay in memory and are never saved; shell aliases and functions are not imported.",
				].join("\n\n"),
			});
			if (choice === 0) return;
			if (await this.attached()) return;
			if (choice === 1) {
				const folders = await this.options.showFolders({
					title: "Choose executable folders",
					buttonLabel: "Add Folders",
					properties: ["openDirectory", "multiSelections"],
				});
				if (folders) {
					if (await this.attached()) return;
					await this.save({
						...preferences,
						extraExecutableDirectories: [...preferences.extraExecutableDirectories, ...folders],
					});
				}
			} else if (choice === 2) {
				await this.save({ ...preferences, extraExecutableDirectories: [] });
			} else if (choice === 3) {
				let result: DesktopEnvironmentRefreshResult;
				try {
					result = await this.options.requestRefresh();
				} catch {
					result = "failed";
				}
				if (await this.attached()) return;
				if (result === "cancelled") return;
				await this.options.showMessage({
					type: result === "refreshed" ? "info" : "warning",
					buttons: ["Close"],
					message:
						result === "refreshed"
							? "Runtime environment refreshed"
							: "Runtime environment could not be refreshed",
					detail:
						result === "refreshed"
							? "The new app-owned runtime uses the saved environment settings."
							: "The app could not confirm a safe restart. Resolve drafts, live-session cleanup, or startup setup before retrying. Saved settings remain available for the next successful refresh.",
				});
				return;
			} else if (choice === 4) {
				await this.save({
					...preferences,
					importLoginShellEnvironment: !preferences.importLoginShellEnvironment,
				});
			} else return;
		}
	}

	private async save(preferences: DesktopEnvironmentPreferences): Promise<boolean> {
		try {
			await writeDesktopEnvironmentPreferences(this.options.userDataPath, preferences);
			return true;
		} catch {
			await this.options.showMessage({
				type: "warning",
				buttons: ["Close"],
				message: "Environment settings could not be saved",
				detail:
					"Choose at most 16 absolute folders with a combined size under 32 KB, and check that Quarterdeck's app storage is writable. The current runtime environment has not changed.",
			});
			return false;
		}
	}
}
