import open from "open";
import { isBinaryAvailableOnPath } from "../core";

type BrowserOpenDeps = {
	openUrl?: typeof open;
	platform?: NodeJS.Platform;
	isBinaryAvailable?: (binary: string) => boolean;
};

export async function openTargetOnHost(target: string, deps?: BrowserOpenDeps): Promise<void> {
	const openUrl = deps?.openUrl ?? open;
	const platform = deps?.platform ?? process.platform;
	const isBinaryAvailable = deps?.isBinaryAvailable ?? isBinaryAvailableOnPath;

	// On Linux the `open` package ships a bundled xdg-open fallback.
	// Prefer system xdg-open when present so PATH-based overrides still work.
	const options = platform === "linux" && isBinaryAvailable("xdg-open") ? { app: { name: "xdg-open" } } : undefined;

	await openUrl(target, options);
}
