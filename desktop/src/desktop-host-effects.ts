import { execFile } from "node:child_process";
import { type BrowserWindow, dialog, shell } from "electron";
import {
	type DesktopHostEffectAction,
	type DesktopHostEffectRequestMessage,
	type DesktopHostEffectResult,
	type DesktopHostEffectResultMessage,
	desktopHostEffectRequestMessageSchema,
	desktopHostEffectResultSchema,
} from "../../src/core/api/desktop-runtime-protocol.js";
import { resolveMacOpenProjectArguments } from "../../src/core/api/mac-open-project.js";

export interface DesktopHostEffectIdentity {
	sender: object;
	startupId: string;
	runtimeGeneration: string;
	ownership: "owned" | "attached";
	synthetic: boolean;
	stopping: boolean;
}

export interface DesktopHostEffectServices {
	showDirectoryDialog: (parent: BrowserWindow) => Promise<Electron.OpenDialogReturnValue>;
	openExternalUrl: (url: string) => Promise<void>;
	openPath: (path: string) => Promise<string>;
	openProject: (args: string[], cwd: string) => Promise<boolean>;
}

const nativeServices: DesktopHostEffectServices = {
	showDirectoryDialog: (parent) =>
		dialog.showOpenDialog(parent, {
			title: "Choose a project folder",
			properties: ["openDirectory", "dontAddToRecent"],
		}),
	openExternalUrl: (url) => shell.openExternal(url, { activate: true }),
	openPath: (path) => shell.openPath(path),
	openProject: (args, cwd) =>
		new Promise((resolve) => {
			execFile("/usr/bin/open", args, { cwd, timeout: 15_000, maxBuffer: 4096 }, (error) => resolve(!error));
		}),
};

export interface DesktopHostEffectDispatcherOptions {
	getIdentity: () => DesktopHostEffectIdentity | null;
	getParentWindow: () => BrowserWindow | null;
	services?: DesktopHostEffectServices;
	deadlineMs?: number;
	maxPending?: number;
}

/** Private helper requests only. No renderer may supply this sender identity. */
export class DesktopHostEffectDispatcher {
	private readonly services: DesktopHostEffectServices;
	private pending = 0;
	private pickerActive = false;
	private sequenceIdentity: string | null = null;
	private lastSequence = 0;
	private disposed = false;

	constructor(private readonly options: DesktopHostEffectDispatcherOptions) {
		this.services = options.services ?? nativeServices;
	}

	async handleMessage(input: unknown, sender: object): Promise<DesktopHostEffectResultMessage | null> {
		const parsed = desktopHostEffectRequestMessageSchema.safeParse(input);
		if (!parsed.success) return null;
		const request = parsed.data;
		const reply = (result: DesktopHostEffectResult): DesktopHostEffectResultMessage => ({
			type: "quarterdeck:desktop-host-result",
			protocolVersion: request.protocolVersion,
			startupId: request.startupId,
			runtimeGeneration: request.runtimeGeneration,
			requestId: request.requestId,
			sequence: request.sequence,
			result,
		});
		if (!this.admitted(request, sender)) return reply({ status: "failed", reason: "denied" });
		const identity = `${request.startupId}:${request.runtimeGeneration}`;
		if (identity !== this.sequenceIdentity) {
			this.sequenceIdentity = identity;
			this.lastSequence = 0;
		}
		if (request.sequence <= this.lastSequence) return reply({ status: "failed", reason: "denied" });
		this.lastSequence = request.sequence;
		if (
			this.pending >= (this.options.maxPending ?? 8) ||
			(request.action.method === "pick-directory" && this.pickerActive)
		)
			return reply({ status: "failed", reason: "busy" });
		this.pending++;
		let timer: NodeJS.Timeout | undefined;
		try {
			// Electron's picker/open APIs cannot be cancelled. Keep their slot until
			// actual completion, even after the IPC deadline, so hung effects stay bounded.
			const operation = this.execute(request.action, () => this.admitted(request, sender)).finally(() => {
				this.pending--;
			});
			const result = await Promise.race([
				operation,
				new Promise<DesktopHostEffectResult>((resolve) => {
					timer = setTimeout(
						() => resolve({ status: "failed", reason: "timeout" }),
						this.options.deadlineMs ?? 120_000,
					);
				}),
			]);
			return reply(this.admitted(request, sender) ? result : { status: "failed", reason: "denied" });
		} catch {
			return reply({ status: "failed", reason: "launch_failed" });
		} finally {
			if (timer) clearTimeout(timer);
		}
	}

	dispose(): void {
		this.disposed = true;
	}

	private admitted(request: DesktopHostEffectRequestMessage, sender: object): boolean {
		const identity = this.options.getIdentity();
		return (
			!this.disposed &&
			!!identity &&
			identity.sender === sender &&
			identity.startupId === request.startupId &&
			identity.runtimeGeneration === request.runtimeGeneration &&
			identity.ownership === "owned" &&
			!identity.synthetic &&
			!identity.stopping
		);
	}

	private async execute(action: DesktopHostEffectAction, admitted: () => boolean): Promise<DesktopHostEffectResult> {
		if (!admitted()) return { status: "failed", reason: "denied" };
		if (action.method === "pick-directory") {
			const parent = this.options.getParentWindow();
			if (!parent || parent.isDestroyed()) return { status: "failed", reason: "unavailable" };
			this.pickerActive = true;
			try {
				if (parent.isMinimized()) parent.restore();
				parent.show();
				parent.focus();
				if (!admitted()) return { status: "failed", reason: "denied" };
				const selection = await this.services.showDirectoryDialog(parent);
				if (selection.canceled || selection.filePaths.length === 0) return { status: "cancelled" };
				const result = desktopHostEffectResultSchema.safeParse({
					status: "selected",
					path: selection.filePaths[0],
				});
				return result.success ? result.data : { status: "failed", reason: "launch_failed" };
			} finally {
				this.pickerActive = false;
				if (admitted() && !parent.isDestroyed()) parent.focus();
			}
		}
		if (action.method === "open-external-url") {
			await this.services.openExternalUrl(action.url);
			return { status: "opened" };
		}
		if (action.method === "open-path") {
			return (await this.services.openPath(action.path))
				? { status: "failed", reason: "launch_failed" }
				: { status: "opened" };
		}
		for (const args of resolveMacOpenProjectArguments(action.targetId, action.path)) {
			if (!admitted()) return { status: "failed", reason: "denied" };
			if (await this.services.openProject(args, action.path)) return { status: "opened" };
		}
		return { status: "failed", reason: "launch_failed" };
	}
}
