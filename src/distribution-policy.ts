import packageJson from "../package.json" with { type: "json" };

/** Release capability, not a user preference. Desktop releases require matching verified public assets. */
export function isDesktopRelease(
	capability: unknown = process.platform === "win32"
		? packageJson.quarterdeck.windowsDesktopRelease
		: packageJson.quarterdeck.desktopRelease,
): boolean {
	return capability === "adhoc-v1" || capability === "signed-v1" || capability === "unsigned-v1";
}
