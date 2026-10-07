import { type BrowserWindow, dialog, type MessageBoxOptions, type OpenDialogOptions } from "electron";
import type { DesktopDraftSaveRequest } from "../../src/shared/desktop-bridge-contract.js";
import type { DesktopUpdateMessage } from "./desktop-updates.js";
import type { DesktopQuitReason, DesktopQuitSummary } from "./quit-coordinator.js";

export class DesktopDialogs {
	constructor(
		private readonly getWindow: () => BrowserWindow | null,
		private readonly synthetic: boolean,
	) {}

	async confirmSessions(summary: DesktopQuitSummary, reason: DesktopQuitReason): Promise<boolean> {
		if (this.synthetic) return true;
		const response = await this.message({
			type: "warning",
			buttons: [
				"Cancel",
				reason === "update"
					? "Stop Sessions and Update"
					: reason === "restart"
						? "Stop Sessions and Restart"
						: "Stop Sessions and Quit",
			],
			defaultId: 0,
			cancelId: 0,
			message: "Stop app-owned sessions?",
			detail: `${summary.liveProcessCount} live terminal ${summary.liveProcessCount === 1 ? "process is" : "processes are"} owned by this app across all projects.${summary.pendingLaunches ? " A task launch is also pending." : ""} Idle and input-waiting sessions will stop too. Saved task and project state will remain available.`,
		});
		return response === 1;
	}

	async confirmUnconfirmedExit(): Promise<boolean> {
		if (this.synthetic) return false;
		return (
			(await this.message({
				type: "warning",
				buttons: ["Keep Open", "Quit Anyway"],
				defaultId: 0,
				cancelId: 0,
				message: "Runtime cleanup is unconfirmed",
				detail:
					"The owned runtime helper exited before confirming that its sessions stopped. Some processes may still be running, and unsaved window edits may be lost. Quit Anyway closes only this app; it does not confirm cleanup or authorize an update. If restart remains blocked by prior-session custody, restart the Mac before retrying.",
			})) === 1
		);
	}

	async inform(reason: "frontend_unavailable" | "runtime_unavailable" | "shutdown_incomplete"): Promise<void> {
		const details = {
			frontend_unavailable:
				"The window did not confirm that unsaved editors are clear. Keep the app open and resolve or recover edits before trying again.",
			runtime_unavailable:
				"The runtime did not provide its authoritative session summary. Keep the app open and retry when the runtime is available.",
			shutdown_incomplete:
				"The runtime did not confirm that sessions stopped and state was saved. Keep the app open and retry. An update cannot install until cleanup succeeds.",
		};
		await this.message({
			type: "warning",
			buttons: ["Keep Open"],
			message: "Quarterdeck could not finish closing",
			detail: details[reason],
		});
	}

	async showUpdate(message: DesktopUpdateMessage): Promise<void> {
		await this.message({ type: message.kind, buttons: ["OK"], message: message.message, detail: message.detail });
	}

	async chooseUpdate(message: DesktopUpdateMessage): Promise<"later" | "restart"> {
		return (await this.message({
			type: "info",
			buttons: ["Later", "Restart to Update"],
			defaultId: 0,
			cancelId: 0,
			message: message.message,
			detail: message.detail,
		})) === 1
			? "restart"
			: "later";
	}

	async chooseDraftPath(request: DesktopDraftSaveRequest): Promise<string | null> {
		if (this.synthetic) return null;
		const window = this.getWindow();
		if (!window || window.isDestroyed()) return null;
		const result = await dialog.showSaveDialog(window, {
			title: "Save recovered editor draft",
			defaultPath: request.suggestedName,
			buttonLabel: "Save Draft",
			properties: ["createDirectory", "showOverwriteConfirmation"],
		});
		return result.canceled ? null : (result.filePath ?? null);
	}
	async chooseFolders(options: OpenDialogOptions): Promise<string[] | null> {
		if (this.synthetic) return null;
		const window = this.getWindow();
		if (!window || window.isDestroyed()) return null;
		const result = await dialog.showOpenDialog(window, options);
		return result.canceled ? null : result.filePaths;
	}

	async message(options: MessageBoxOptions): Promise<number> {
		if (this.synthetic) return options.cancelId ?? 0;
		const window = this.getWindow();
		if (!window || window.isDestroyed()) return options.cancelId ?? 0;
		return (await dialog.showMessageBox(window, options)).response;
	}
}
