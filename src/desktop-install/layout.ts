import { existsSync } from "node:fs";
import { join } from "node:path";

export function desktopResourcesPath(appPath: string, platform: NodeJS.Platform): string {
	if (platform === "win32") {
		return join(appPath, existsSync(join(appPath, "host")) ? "host/resources" : "resources");
	}
	return join(appPath, "Contents/Resources");
}
export function desktopBootstrapPath(appPath: string, platform: NodeJS.Platform): string {
	return join(
		desktopResourcesPath(appPath, platform),
		"runtime",
		platform === "win32" ? "installation-admission.exe" : "installation-admission",
	);
}
export function desktopTransactionBootstrapName(platform: NodeJS.Platform): string {
	return platform === "win32" ? "mutation-bootstrap.exe" : "mutation-bootstrap";
}
export function desktopGlobalPackageSlot(prefix: string, platform: NodeJS.Platform = process.platform): string {
	return join(prefix, platform === "win32" ? "node_modules/quarterdeck" : "lib/node_modules/quarterdeck");
}
