import type { AutoUpdater } from "electron";
import { canonicalDesktopValidationFeedBase, DESKTOP_PRODUCTION_FEED_BASE } from "./desktop-update-feed.js";

export type DesktopUpdateDisabledReason =
	| "unsigned"
	| "synthetic"
	| "unsupported"
	| "production_feed_disabled"
	| "npm_managed";
export type DesktopUpdateEligibility =
	| { enabled: true; arch: "arm64" | "x64"; version: string; validationFeedBase?: string }
	| { enabled: false; reason: DesktopUpdateDisabledReason };

/** These facts come from main-process package/signature verification, never renderer input. */
export function desktopUpdateEligibility(facts: {
	isPackaged: boolean;
	synthetic: boolean;
	platform: NodeJS.Platform;
	arch: string;
	version: string;
	signed: boolean;
	hardened: boolean;
	productionFeedEnabled: boolean;
	validationFeedBase?: string;
}): DesktopUpdateEligibility {
	if (facts.synthetic) return { enabled: false, reason: "synthetic" };
	if (!facts.isPackaged || !facts.signed || !facts.hardened) return { enabled: false, reason: "unsigned" };
	if (
		facts.platform !== "darwin" ||
		(facts.arch !== "arm64" && facts.arch !== "x64") ||
		!/^\d+\.\d+\.\d+$/u.test(facts.version)
	)
		return { enabled: false, reason: "unsupported" };
	if (facts.validationFeedBase !== undefined) {
		const base = canonicalDesktopValidationFeedBase(facts.validationFeedBase);
		if (!base || facts.productionFeedEnabled) return { enabled: false, reason: "unsupported" };
		return { enabled: true, arch: facts.arch, version: facts.version, validationFeedBase: base };
	}
	if (!facts.productionFeedEnabled) return { enabled: false, reason: "production_feed_disabled" };
	return { enabled: true, arch: facts.arch, version: facts.version };
}

export type DesktopUpdatePhase =
	| "disabled"
	| "idle"
	| "checking"
	| "downloading"
	| "downloaded"
	| "restarting"
	| "error";
export type DesktopUpdateReason =
	| DesktopUpdateDisabledReason
	| "update_failed"
	| "shutdown_incomplete"
	| "normal_quit"
	| "restart_failed"
	| "dialog_failed";
export interface DesktopUpdateStatus {
	phase: DesktopUpdatePhase;
	pending: boolean;
	reason?: DesktopUpdateReason;
}
export interface DesktopUpdateMessage {
	kind: "info" | "error";
	message: string;
	detail: string;
}
export interface DesktopUpdateOptions {
	updater: Pick<AutoUpdater, "setFeedURL" | "checkForUpdates" | "quitAndInstall"> &
		Pick<NodeJS.EventEmitter, "on" | "removeListener">;
	eligibility: DesktopUpdateEligibility;
	/** Shared main-process preflight + completion lease; true means helper cleanup actually completed. */
	preflightAndShutdown: () => Promise<boolean>;
	/** Normal Quit wins a race with Restart to Update; excludes the updater's own shutdown request. */
	isNormalQuitPending: () => boolean;
	showMessage: (message: DesktopUpdateMessage) => Promise<void>;
	chooseDownloadedUpdate: (message: DesktopUpdateMessage) => Promise<"later" | "restart">;
	onStatusChanged?: (status: DesktopUpdateStatus) => void;
	onEvidence?: (status: DesktopUpdateStatus) => void;
	/** Installer rejection occurs after verified cleanup; main releases the frontend seal and retains the clean receipt. */
	onRestartFailed?: () => Promise<void>;
}

const downloadedMessage: DesktopUpdateMessage = {
	kind: "info",
	message: "An update is ready to install",
	detail:
		"Restart to Update checks unsaved work and safely stops app-owned sessions first. Later keeps you working; the downloaded update may install at the next safe quit and relaunch.",
};

/** Electron owns download/install mechanics; main owns all project state and quit decisions. */
export class DesktopUpdates {
	private status: DesktopUpdateStatus;
	private disposed = false;
	private prompt: Promise<void> | null = null;
	private restart: Promise<boolean> | null = null;
	private restartRecovery: Promise<void> | null = null;
	private restartRecoveryFailed = false;
	private installationAttempted = false;
	private readonly listeners: Array<{ event: string; listener: () => void }> = [];

	constructor(private readonly options: DesktopUpdateOptions) {
		this.status = options.eligibility.enabled
			? { phase: "idle", pending: false }
			: { phase: "disabled", pending: false, reason: options.eligibility.reason };
		if (!options.eligibility.enabled) return;
		this.listen("checking-for-update", () => {
			if (this.status.phase === "checking") this.setStatus("checking");
		});
		this.listen("update-available", () => {
			if (this.status.phase === "checking") this.setStatus("downloading");
		});
		this.listen("update-not-available", () => {
			if (this.status.phase !== "checking") return;
			this.setStatus("idle");
			void this.inform({
				kind: "info",
				message: "Quarterdeck is up to date",
				detail: "You are using the latest stable desktop release.",
			});
		});
		this.listen("update-downloaded", () => {
			if (this.status.pending || !["checking", "downloading"].includes(this.status.phase)) return;
			this.status = { phase: "downloaded", pending: true };
			this.publishStatus();
			void this.offerDownloaded();
		});
		this.listen("error", () => this.updateFailed());
		try {
			options.updater.setFeedURL({
				url: `${options.eligibility.validationFeedBase ?? DESKTOP_PRODUCTION_FEED_BASE}darwin-${options.eligibility.arch}/${options.eligibility.version}`,
			});
		} catch {
			this.setStatus("error", "update_failed");
		}
	}

	snapshot(): DesktopUpdateStatus {
		return { ...this.status };
	}

	async checkForUpdates(): Promise<void> {
		if (this.disposed || this.options.isNormalQuitPending()) return;
		if (this.status.phase === "disabled") {
			await this.inform({
				kind: "info",
				message: "Updates are unavailable for this build",
				detail:
					this.status.reason === "npm_managed"
						? "This app is managed by npm. Update the quarterdeck npm package, then run quarterdeck --desktop to install its matching app."
						: "Automatic updates require a verified signed macOS build with its signed production or validation feed enabled. Unsigned and Agent Lab builds cannot install updates.",
			});
			return;
		}
		if (this.status.pending) return this.offerDownloaded();
		if (["checking", "downloading", "restarting"].includes(this.status.phase)) {
			await this.inform({
				kind: "info",
				message: "An update check is already in progress",
				detail: "Quarterdeck will notify you when the download completes or the check fails.",
			});
			return;
		}
		this.setStatus("checking");
		try {
			this.options.updater.checkForUpdates();
		} catch {
			this.updateFailed();
		}
	}

	restartToUpdate(): Promise<boolean> {
		if (this.restart) return this.restart;
		if (
			this.disposed ||
			!this.status.pending ||
			this.restartRecovery !== null ||
			this.restartRecoveryFailed ||
			this.status.phase === "restarting" ||
			this.options.isNormalQuitPending()
		)
			return Promise.resolve(false);
		this.setStatus("restarting");
		this.restart = Promise.resolve()
			.then(() => this.performRestart())
			.finally(() => {
				this.restart = null;
			});
		return this.restart;
	}

	dispose(): void {
		this.disposed = true;
		for (const { event, listener } of this.listeners) this.options.updater.removeListener(event, listener);
		this.listeners.length = 0;
	}

	private listen(event: string, listener: () => void): void {
		const guarded = () => {
			if (!this.disposed) listener();
		};
		this.options.updater.on(event, guarded);
		this.listeners.push({ event, listener: guarded });
	}

	private async performRestart(): Promise<boolean> {
		try {
			const complete = await this.options.preflightAndShutdown();
			if (this.disposed || this.options.isNormalQuitPending()) {
				this.setStatus("downloaded", "normal_quit");
				return false;
			}
			if (!complete) {
				this.setStatus("downloaded", "shutdown_incomplete");
				return false;
			}
			if (this.status.phase !== "restarting") {
				await this.recoverInstallerFailure();
				return false;
			}
			this.installationAttempted = true;
			this.options.updater.quitAndInstall();
			// Electron can emit an error synchronously or asynchronously instead of throwing.
			await Promise.resolve();
			if (this.restartRecovery) await this.restartRecovery;
			return this.status.phase === "restarting" && !this.status.reason;
		} catch {
			if (this.installationAttempted) {
				await this.recoverInstallerFailure();
				return false;
			}
			this.setStatus("downloaded", "restart_failed");
			await this.inform({
				kind: "error",
				message: "The update is still pending",
				detail:
					"Quarterdeck could not complete a safe restart. Keep the app open and retry Restart to Update after resolving the shutdown problem.",
			});
			return false;
		}
	}

	private offerDownloaded(): Promise<void> {
		if (this.prompt) return this.prompt;
		if (
			this.disposed ||
			!this.status.pending ||
			this.options.isNormalQuitPending() ||
			this.status.phase === "restarting"
		)
			return Promise.resolve();
		this.prompt = this.chooseDownloaded().finally(() => {
			this.prompt = null;
		});
		return this.prompt;
	}

	private async chooseDownloaded(): Promise<void> {
		try {
			const choice = await this.options.chooseDownloadedUpdate(downloadedMessage);
			if (choice === "restart") await this.restartToUpdate();
		} catch {
			this.setStatus("downloaded", "dialog_failed");
		}
	}

	private updateFailed(): void {
		if (this.status.phase === "restarting" && this.installationAttempted) {
			void this.recoverInstallerFailure();
			return;
		}
		this.setStatus(this.status.pending ? "downloaded" : "error", "update_failed");
		void this.inform({
			kind: "error",
			message: "Could not check for updates",
			detail:
				"Check your internet connection and try again. Your current application and saved data remain available.",
		});
	}

	private recoverInstallerFailure(): Promise<void> {
		if (this.restartRecovery) return this.restartRecovery;
		this.setStatus("restarting", "restart_failed");
		this.restartRecovery = Promise.resolve()
			.then(async () => {
				try {
					await this.options.onRestartFailed?.();
				} catch {
					this.restartRecoveryFailed = true;
				}
				this.installationAttempted = false;
				this.setStatus("downloaded", "restart_failed");
				await this.inform({
					kind: "error",
					message: "The update could not restart Quarterdeck",
					detail: this.restartRecoveryFailed
						? "App-owned sessions were stopped safely, but update recovery did not complete. Quit and reopen Quarterdeck before trying again. Your pending update and saved data are retained."
						: "App-owned sessions were stopped safely. The update remains pending. Review or export any local drafts, then retry Restart to Update, or quit and reopen Quarterdeck. The runtime will not restart automatically.",
				});
			})
			.finally(() => {
				this.restartRecovery = null;
			});
		return this.restartRecovery;
	}

	private async inform(message: DesktopUpdateMessage): Promise<void> {
		try {
			await this.options.showMessage(message);
		} catch {
			/* Presentation failure cannot authorize installation. */
		}
	}

	private setStatus(phase: DesktopUpdatePhase, reason?: DesktopUpdateReason): void {
		this.status = { phase, pending: this.status.pending, ...(reason ? { reason } : {}) };
		this.publishStatus();
	}

	private publishStatus(): void {
		// Diagnostics receives fixed metadata only; observer failures cannot change updater authority.
		for (const callback of [this.options.onStatusChanged, this.options.onEvidence]) {
			try {
				callback?.(this.snapshot());
			} catch {
				/* Observers are not a lifecycle gate. */
			}
		}
	}
}
