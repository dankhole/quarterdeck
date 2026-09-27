import { TERMINAL_IMAGE_PASTE_MAX_BYTES, TERMINAL_IMAGE_PASTE_MAX_COUNT } from "@runtime-contract";
import { ClipboardAddon, type IClipboardProvider } from "@xterm/addon-clipboard";
import type { Terminal } from "@xterm/xterm";
import { notifyError } from "@/components/app-toaster";
import { browserHostIntegrations } from "@/runtime/browser-host-integrations";
import type { RuntimeAgentId } from "@/runtime/types";
import type { TerminalImagePasteWriter } from "@/terminal/terminal-input";
import { resolveTerminalKey } from "@/terminal/terminal-key-policy";
import { isMacPlatform } from "@/utils/platform";
import { collectImageFilesFromDataTransfer, fileToTaskImage } from "@/utils/task-image-input";

async function copyText(text: string): Promise<void> {
	try {
		await browserHostIntegrations.writeClipboardText(text);
	} catch {
		notifyError("Could not copy terminal text. Check clipboard permissions and try again.", { key: "terminal-copy" });
	}
}

const clipboardProvider: IClipboardProvider = {
	async readText(selection) {
		if (selection !== "c") return "";
		try {
			return await browserHostIntegrations.readClipboardText();
		} catch {
			notifyError("Could not read the clipboard. Check clipboard permissions and try again.", {
				key: "terminal-paste",
			});
			return "";
		}
	},
	async writeText(selection, text) {
		if (selection === "c") await copyText(text);
	},
};

/** Owns browser input effects; xterm retains text paste, encoding, and IME handling. */
export class TerminalBrowserInput {
	constructor(
		terminal: Terminal,
		private readonly host: HTMLElement,
		private readonly callbacks: {
			getSessionAgentId: () => RuntimeAgentId | null;
			beginImagePaste: () => TerminalImagePasteWriter | null;
		},
	) {
		terminal.loadAddon(new ClipboardAddon(undefined, clipboardProvider));
		terminal.attachCustomKeyEventHandler((event) => {
			const action = resolveTerminalKey(event, {
				isMac: isMacPlatform,
				agentId: callbacks.getSessionAgentId(),
				hasSelection: terminal.hasSelection(),
				alternateScreen: terminal.buffer.active.type === "alternate",
				mouseTracking: terminal.modes.mouseTrackingMode !== "none",
			});
			if (action.kind === "pass") return true;
			event.preventDefault();
			event.stopPropagation();
			if (action.kind === "copy") void copyText(terminal.getSelection());
			if (action.kind === "send") terminal.input(action.data);
			return false;
		});
		// Capture before xterm's text-only paste listener consumes an image event.
		host.addEventListener("paste", this.onPaste, true);
	}

	private readonly onPaste = (event: ClipboardEvent): void => {
		if (!event.clipboardData || event.defaultPrevented) return;
		const files = collectImageFilesFromDataTransfer(event.clipboardData);
		if (files.length === 0) return;
		event.preventDefault();
		event.stopImmediatePropagation();
		const writer = this.callbacks.beginImagePaste();
		if (!writer) {
			notifyError("Image paste requires a connected task-agent terminal.", { key: "terminal-image-paste" });
			return;
		}
		void this.pasteImages(files, writer);
	};

	private async pasteImages(files: File[], writer: TerminalImagePasteWriter): Promise<void> {
		try {
			if (
				files.length > TERMINAL_IMAGE_PASTE_MAX_COUNT ||
				files.reduce((sum, file) => sum + file.size, 0) > TERMINAL_IMAGE_PASTE_MAX_BYTES
			) {
				throw new Error("Image paste supports up to 10 images totaling 20 MB.");
			}
			const images = await Promise.all(files.map(fileToTaskImage));
			if (images.some((image) => image === null)) throw new Error("Could not read the pasted image.");
			await writer(images.filter((image) => image !== null));
		} catch {
			notifyError("Could not paste images. Use up to 10 images totaling 20 MB and keep the task connected.", {
				key: "terminal-image-paste",
			});
		}
	}

	dispose(): void {
		this.host.removeEventListener("paste", this.onPaste, true);
	}
}
