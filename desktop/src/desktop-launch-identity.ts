import { createHash } from "node:crypto";
import { realpath } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import {
	type DesktopLaunchAppIdentity,
	desktopLaunchAppIdentitySchema,
} from "../../src/shared/desktop-launch-contract.js";
import { readRuntimeBundle } from "./runtime-bundle.js";

/** Actual selected package bytes bind npm launch requests, including a same-version local rebuild. */
export async function readDesktopLaunchAppIdentity(
	appAsarPath: string,
	resourceRoot: string,
	version: string,
	arch: string,
	readArchive: (path: string) => Promise<Buffer>,
): Promise<DesktopLaunchAppIdentity> {
	if (!appAsarPath.endsWith("/Contents/Resources/app.asar"))
		throw new Error("Npm desktop launching requires a packaged Quarterdeck app.");
	const bundle = readRuntimeBundle(resourceRoot, version, arch);
	return desktopLaunchAppIdentitySchema.parse({
		version,
		arch,
		appPath: await realpath(resolve(dirname(appAsarPath), "..", "..")),
		buildId: bundle.buildId,
		appAsarSha256: createHash("sha256")
			.update(await readArchive(appAsarPath))
			.digest("hex"),
	});
}
