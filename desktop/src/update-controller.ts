import type { Clipboard, MessageBoxOptions } from "electron";
import {
	type DesktopInstallation,
	DesktopInstallationError,
	validateDesktopInstallation,
} from "../../src/desktop-install/index.js";
import { sameDesktopOwner } from "../../src/desktop-install/owner.js";
import {
	checkForDesktopUpdate,
	DesktopUpdateCheckError,
	isDesktopUpdateTarget,
} from "../../src/desktop-update/check.js";
import type { DesktopUpdateIntent, DesktopUpdateSnapshot } from "../../src/shared/desktop-update-contract.js";
import { NpmUpdatePreparationError, type PreparedNpmUpdate, prepareNpmUpdate } from "./npm-update-runner.js";
import type { DesktopQuitResult } from "./quit-coordinator.js";
import { desktopUpdateGuidance, showDesktopUpdateGuidance } from "./update-guidance.js";

export const DESKTOP_RELEASE_NOTES_URL = "https://github.com/dankhole/quarterdeck/releases";

export interface DesktopUpdateControllerOptions {
	installation: DesktopInstallation | null;
	installedVersion: string;
	synthetic: boolean;
	dialogs: { message: (options: MessageBoxOptions) => Promise<number> };
	clipboard: Pick<Clipboard, "writeText">;
	openReleaseNotes: () => Promise<void>;
	getEnvironment: () => NodeJS.ProcessEnv | null;
	canTransition: () => boolean;
	requestQuit: (authorize: () => Promise<void>) => Promise<DesktopQuitResult>;
	onCancelledQuit?: () => void;
	quit: () => void;
	check?: typeof checkForDesktopUpdate;
	validateInstallation?: typeof validateDesktopInstallation;
	prepare?: typeof prepareNpmUpdate;
}

/** Main owns discovery and one explicit handoff; npm and the quit coordinator retain their own authority. */
export class DesktopUpdateController {
	private snapshot: DesktopUpdateSnapshot;
	private readonly listeners = new Set<(snapshot: DesktopUpdateSnapshot) => void>();
	private checking: { promise: Promise<void>; explicit: boolean } | null = null;
	private details: Promise<void> | null = null;
	private prepared: PreparedNpmUpdate | null = null;
	private started = false;
	private disposed = false;
	private committed = false;
	private epoch = 0;

	constructor(private readonly options: DesktopUpdateControllerOptions) {
		this.snapshot = {
			phase: options.synthetic || options.installation?.owner.kind !== "npm" ? "disabled" : "idle",
			installedVersion: options.installedVersion,
			availableVersion: null,
			channel: null,
		};
	}

	getSnapshot(): DesktopUpdateSnapshot {
		return { ...this.snapshot };
	}

	subscribe(listener: (snapshot: DesktopUpdateSnapshot) => void): () => void {
		if (!this.disposed) this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	isBusy(): boolean {
		return this.details !== null || this.snapshot.phase === "preparing" || this.snapshot.phase === "quitting";
	}

	start(): void {
		if (this.started || this.disposed) return;
		this.started = true;
		void this.check(false);
	}

	request(intent: DesktopUpdateIntent): Promise<void> {
		const installation = this.options.installation;
		if (this.details) return this.details;
		if (this.disposed || this.options.synthetic || !installation || this.isBusy() || !this.options.canTransition())
			return Promise.resolve();
		if (installation.owner.kind === "link")
			return this.presentDetails(() =>
				showDesktopUpdateGuidance(installation.owner, this.options.dialogs, this.options.clipboard),
			);
		if (intent === "check" || this.checking) return this.check(true);
		return this.presentDetails(async () => {
			if (!this.disposed && this.snapshot.phase === "available") await this.showAvailable();
		});
	}

	dispose(): void {
		if (this.disposed) return;
		this.disposed = true;
		this.epoch += 1;
		this.listeners.clear();
		if (!this.committed) void this.prepared?.cancel().catch(() => undefined);
	}

	private presentDetails(action: () => Promise<void>): Promise<void> {
		this.details = action()
			.catch(() => undefined)
			.finally(() => {
				this.details = null;
				this.publish({});
			});
		this.publish({});
		return this.details;
	}

	private publish(next: Partial<DesktopUpdateSnapshot>): void {
		if (this.disposed) return;
		this.snapshot = { ...this.snapshot, ...next };
		for (const listener of this.listeners) {
			try {
				listener(this.getSnapshot());
			} catch {
				/* A retired renderer cannot interrupt update or cancellation ownership. */
			}
		}
	}

	private check(explicit: boolean): Promise<void> {
		if (this.disposed || this.snapshot.phase === "disabled" || this.isBusy()) return Promise.resolve();
		if (this.checking) {
			this.checking.explicit ||= explicit;
			return this.checking.promise;
		}
		const epoch = ++this.epoch;
		// A refresh revokes the previous target immediately, including when the registry later fails.
		this.publish({ phase: "checking", availableVersion: null, channel: null });
		const operation = { explicit, promise: Promise.resolve() };
		this.checking = operation;
		operation.promise = (async () => {
			let failureDetail =
				"The public npm registry could not be checked. Check your connection and choose Check for Updates again.";
			try {
				const result = await (this.options.check ?? checkForDesktopUpdate)(this.options.installedVersion);
				if (this.disposed || epoch !== this.epoch) return;
				this.publish({
					phase: result.availableVersion ? "available" : "current",
					availableVersion: result.availableVersion,
					channel: result.channel,
				});
			} catch (error: unknown) {
				if (this.disposed || epoch !== this.epoch) return;
				if (error instanceof DesktopUpdateCheckError) failureDetail = error.message;
				this.publish({ phase: "failed", availableVersion: null, channel: null });
			} finally {
				if (this.checking === operation) this.checking = null;
			}
			if (!operation.explicit || this.disposed || epoch !== this.epoch || !this.options.canTransition()) return;
			if (this.snapshot.phase === "available") await this.presentDetails(() => this.showAvailable());
			else
				await this.options.dialogs.message({
					type: this.snapshot.phase === "failed" ? "warning" : "info",
					buttons: ["OK"],
					message: this.snapshot.phase === "failed" ? "Could not check for updates" : "Quarterdeck is up to date",
					detail:
						this.snapshot.phase === "failed"
							? failureDetail
							: `Installed version: ${this.options.installedVersion}\nUpdate channel: ${this.snapshot.channel}`,
				});
		})().catch(() => undefined);
		return operation.promise;
	}

	private async showAvailable(): Promise<void> {
		const installation = this.options.installation;
		const targetVersion = this.snapshot.availableVersion;
		const epoch = this.epoch;
		if (
			!installation ||
			!targetVersion ||
			this.disposed ||
			this.snapshot.phase !== "available" ||
			!this.options.canTransition()
		)
			return;
		const choice = await this.options.dialogs.message({
			type: "info",
			buttons: ["Done", "Release Notes", "Update Quarterdeck"],
			defaultId: 0,
			cancelId: 0,
			message: `Quarterdeck v${targetVersion} is available`,
			detail: `Installed version: ${this.options.installedVersion}\nAvailable version: ${targetVersion}\nOwning npm prefix: ${installation.owner.prefix}\n\nUpdating opens Terminal to install this exact version with npm. Quarterdeck must close normally first; review unsaved edits and allow app-owned sessions to stop. Reopen the app after Terminal reports success.`,
		});
		if (this.disposed || epoch !== this.epoch || this.snapshot.availableVersion !== targetVersion) return;
		if (choice === 1) await this.options.openReleaseNotes();
		if (choice === 2) await this.update(targetVersion, epoch);
	}

	private async update(targetVersion: string, epoch: number): Promise<void> {
		const installation = this.options.installation;
		const environment = this.options.getEnvironment();
		if (
			!installation ||
			!environment ||
			!this.options.canTransition() ||
			this.disposed ||
			epoch !== this.epoch ||
			this.snapshot.phase !== "available" ||
			!isDesktopUpdateTarget(this.options.installedVersion, targetVersion)
		)
			return;
		this.publish({ phase: "preparing" });
		let prepared: PreparedNpmUpdate | null = null;
		let quitRequested = false;
		try {
			const current = await (this.options.validateInstallation ?? validateDesktopInstallation)({
				appPath: installation.appPath,
				version: this.options.installedVersion,
			});
			if (
				!sameDesktopOwner(current.owner, installation.owner) ||
				current.installId !== installation.installId ||
				current.buildId !== installation.buildId ||
				current.appAsarSha256 !== installation.appAsarSha256 ||
				current.cleanupPending
			)
				throw new DesktopInstallationError(
					"installation_changed",
					"The owning installation changed. Quit Quarterdeck and repair its recorded npm installation before updating.",
				);
			if (this.disposed || epoch !== this.epoch) return;
			prepared = await (this.options.prepare ?? prepareNpmUpdate)({
				installation,
				targetVersion,
				environment,
			});
			this.prepared = prepared;
			if (this.disposed || epoch !== this.epoch) return;
			await prepared.launch();
			if (this.disposed || epoch !== this.epoch) return;
			this.publish({ phase: "quitting" });
			let armed = false;
			const handoff = prepared;
			quitRequested = true;
			const result = await this.options.requestQuit(async () => {
				if (this.disposed || epoch !== this.epoch) throw new Error("Update cancelled");
				await handoff.authorize();
				armed = true;
			});
			if (this.disposed || result.kind !== "clean" || !armed) {
				this.publish({ phase: "available" });
				return;
			}
			// No await or fallible teardown may separate the final commit from requesting app exit.
			handoff.commit();
			this.committed = true;
			this.options.quit();
		} catch (error: unknown) {
			// A committed update remains a quit transaction. Never present it as cancelled or reopen lifecycle work.
			if (this.disposed || this.committed) return;
			this.publish({ phase: "failed", availableVersion: null });
			const guidance = desktopUpdateGuidance(installation.owner, targetVersion);
			await this.options.dialogs
				.message({
					type: "warning",
					buttons: ["Keep Open", "Copy Command"],
					defaultId: 0,
					cancelId: 0,
					message: "Quarterdeck could not prepare the update",
					detail: `${error instanceof NpmUpdatePreparationError || error instanceof DesktopInstallationError ? `${error.message}\n\n` : ""}${guidance.detail}`,
				})
				.then((choice) => {
					if (choice === 1 && !this.disposed) this.options.clipboard.writeText(guidance.command);
				});
		} finally {
			if (prepared && !this.committed) await prepared.cancel().catch(() => undefined);
			if (quitRequested && !this.committed) {
				try {
					this.options.onCancelledQuit?.();
				} catch {
					/* Recovery presentation cannot authorize an inert handoff. */
				}
			}
			this.prepared = null;
		}
	}
}
