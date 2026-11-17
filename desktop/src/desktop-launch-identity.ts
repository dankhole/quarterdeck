import { createHash } from "node:crypto";
import { realpath } from "node:fs/promises";
import {
	type DesktopLaunchAppIdentity,
	desktopLaunchAppIdentitySchema,
} from "../../src/shared/desktop-launch-contract.js";
import { desktopAppRoot } from "./app-layout.js";
import { readRuntimeBundle } from "./runtime-bundle.js";

/** Actual selected package bytes bind npm launch requests, including a same-version local rebuild. */
export async function readDesktopLaunchAppIdentity(
	appAsarPath: string,
	resourceRoot: string,
	version: string,
	arch: string,
	readArchive: (path: string) => Promise<Buffer>,
	platform: NodeJS.Platform = process.platform,
): Promise<DesktopLaunchAppIdentity> {
	const appPath = desktopAppRoot(appAsarPath, platform);
	const bundle = readRuntimeBundle(resourceRoot, version, arch, platform);
	return desktopLaunchAppIdentitySchema.parse({
		version,
		arch,
		appPath: await realpath(appPath),
		buildId: bundle.buildId,
		appAsarSha256: createHash("sha256")
			.update(await readArchive(appAsarPath))
			.digest("hex"),
	});
}
