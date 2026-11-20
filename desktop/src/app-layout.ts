import { posix, win32 } from "node:path";

/** Resolve the physical package root, never by trimming a platform-specific path string. */
export function desktopAppRoot(appAsarPath: string, platform: NodeJS.Platform = process.platform): string {
	const paths = platform === "win32" ? win32 : posix;
	if (platform !== "darwin" && platform !== "win32") throw new Error("Unsupported desktop platform.");
	const resources = paths.dirname(appAsarPath);
	if (paths.basename(appAsarPath) !== "app.asar" || !paths.isAbsolute(appAsarPath))
		throw new Error("Npm desktop launching requires a packaged Quarterdeck app.");
	if (platform === "win32" && paths.basename(resources).toLowerCase() === "resources") {
		const host = paths.dirname(resources);
		return paths.basename(host).toLowerCase() === "host" ? paths.dirname(host) : host;
	}
	if (
		platform === "darwin" &&
		paths.basename(resources) === "Resources" &&
		paths.basename(paths.dirname(resources)) === "Contents"
	) {
		const root = paths.resolve(resources, "..", "..");
		if (root.endsWith(".app")) return root;
	}
	throw new Error("Npm desktop launching requires a packaged Quarterdeck app.");
}
