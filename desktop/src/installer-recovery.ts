export interface DesktopInstallerRecovery {
	releaseFrontendSeal: () => void;
	reopenQuitGate: () => void;
	hasWindow: () => boolean;
	createWindow: () => void;
	showStoppedSurface: () => Promise<void>;
	markRuntimeStopped: () => void;
}

/** Electron may destroy every window before an installer rejects. Preserve the clean receipt and restore local recovery. */
export async function recoverDesktopAfterInstallerFailure(options: DesktopInstallerRecovery): Promise<void> {
	options.releaseFrontendSeal();
	options.reopenQuitGate();
	if (!options.hasWindow()) {
		options.createWindow();
		await options.showStoppedSurface();
	}
	options.markRuntimeStopped();
}
