import { readFile, realpath } from "node:fs/promises";
import { dirname, join, sep } from "node:path";
import packageJson from "../package.json" with { type: "json" };

/** Release capability, not a user preference. Desktop releases require matching verified public assets. */
export function isDesktopRelease(capability: unknown = packageJson.quarterdeck.desktopRelease): boolean {
	return capability === "adhoc-v1" || capability === "signed-v1";
}

export function wantsDesktopInstallation(mode: string | undefined, desktopRelease = isDesktopRelease()): boolean {
	return mode === "desktop" || (!mode && desktopRelease);
}

/** Prefix-scoped preference survives npm replacing its package directory during upgrades. */
export async function hasBrowserInstallPreference(packageRoot: string): Promise<boolean> {
	try {
		const preference: unknown = JSON.parse(
			await readFile(join(dirname(packageRoot), ".quarterdeck-install-mode.json"), "utf8"),
		);
		if (
			typeof preference === "object" &&
			preference !== null &&
			"schemaVersion" in preference &&
			preference.schemaVersion === 1 &&
			"mode" in preference &&
			preference.mode === "browser"
		)
			return true;
	} catch {
		// Missing/skipped lifecycle scripts are not a browser opt-out. Launch must
		// validate the installed desktop pair and explain explicit repair instead.
	}
	return false;
}

/** npm's package slot distinguishes global installation from source and transient npx use. */
export async function usesDesktopLaunchDefault(packageRoot: string): Promise<boolean> {
	if (!isDesktopRelease()) return false;
	const root = await realpath(packageRoot);
	if (!root.endsWith(join(sep, "lib", "node_modules", "quarterdeck"))) return false;
	return !(await hasBrowserInstallPreference(root));
}
