import type { ExecFileException } from "node:child_process";
import { execFile } from "node:child_process";
import open from "open";
import { isBinaryAvailableOnPath } from "../core";

const MACOS_OPEN_PATH = "/usr/bin/open";

type MacOpenLauncher = (command: string, args: string[], callback: (error: ExecFileException | null) => void) => void;

type BrowserOpenDeps = {
	openUrl?: typeof open;
	platform?: NodeJS.Platform;
	isBinaryAvailable?: (binary: string) => boolean;
	launchMacOpen?: MacOpenLauncher;
};

function launchMacOpen(command: string, args: string[], callback: (error: ExecFileException | null) => void): void {
	execFile(command, args, (error) => callback(error));
}

function openTargetWithMacLauncher(target: string, launcher: MacOpenLauncher): Promise<void> {
	return new Promise((resolve, reject) => {
		// Unlike the `open` package's default macOS path, waiting for this short-lived
		// launcher process observes LaunchServices rejection without waiting for the
		// browser application itself to close.
		launcher(MACOS_OPEN_PATH, [target], (error) => {
			if (error) {
				reject(error);
				return;
			}
			resolve();
		});
	});
}

export async function openTargetOnHost(target: string, deps?: BrowserOpenDeps): Promise<void> {
	const openUrl = deps?.openUrl ?? open;
	const platform = deps?.platform ?? process.platform;
	const isBinaryAvailable = deps?.isBinaryAvailable ?? isBinaryAvailableOnPath;
	if (platform === "darwin") {
		await openTargetWithMacLauncher(target, deps?.launchMacOpen ?? launchMacOpen);
		return;
	}

	// On Linux the `open` package ships a bundled xdg-open fallback.
	// Prefer system xdg-open when present so PATH-based overrides still work.
	const options =
		platform === "linux" && isBinaryAvailable("xdg-open") ? { app: { name: "xdg-open" }, wait: true } : undefined;

	await openUrl(target, options);
}
