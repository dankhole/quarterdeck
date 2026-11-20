import { join } from "node:path";
import { z } from "zod";
import { desktopResourcePathsForPlatform } from "../../desktop/scripts/desktop-resource-paths.mjs";
import { windowsPeArchitecture } from "../../desktop/scripts/windows-pe.mjs";
import type { DesktopAppIdentity } from "./app-identity.js";
import { readDesktopBundleIdentity } from "./bundle-identity.js";
import { DesktopInstallationError } from "./errors.js";
import { desktopAppTreeSha256, desktopFileSha256, desktopPhysicalFileSystem, readDesktopJson } from "./files.js";
import { desktopResourcesPath } from "./layout.js";
import type { DesktopReleaseManifest } from "./metadata.js";
import { desktopApplicationBundleId } from "./receipt.js";
import type { DesktopInstallationArchitecture } from "./types.js";

/** Physical PE/resource inspection; no candidate code is executed by the installer. */
export async function inspectWindowsDesktopApp(
	appPath: string,
	version: string,
	arch: DesktopInstallationArchitecture,
	release?: DesktopReleaseManifest,
): Promise<DesktopAppIdentity & { launcherSha256: string }> {
	const canonical = await desktopPhysicalFileSystem.realpath(appPath);
	const tree = await desktopAppTreeSha256(canonical);
	const resources = desktopResourcesPath(canonical, "win32");
	const host =
		resources === join(canonical, "resources")
			? join(canonical, "QuarterdeckHost.exe")
			: join(canonical, "host", "Quarterdeck.exe");
	const bundle = await readDesktopBundleIdentity(resources, version, arch, "win32");
	if (
		!["local", "windows-unsigned"].includes(bundle.distributionMode ?? "local") ||
		bundle.signedDistribution ||
		bundle.expectedTeamId !== null
	)
		throw new DesktopInstallationError("invalid_artifact", "Invalid Windows distribution policy.");
	if (
		release &&
		Object.keys(bundle).some(
			(field) =>
				JSON.stringify(bundle[field as keyof typeof bundle]) !==
				JSON.stringify(release[field as keyof typeof release]),
		)
	)
		throw new DesktopInstallationError(
			"invalid_artifact",
			"Windows bundle provenance differs from its release manifest.",
		);
	const shell = z
		.object({
			name: z.literal("quarterdeck-desktop"),
			bundleId: z.literal(desktopApplicationBundleId),
			version: z.string(),
			buildId: z.string(),
			sourceSha: z.string(),
		})
		.parse(await readDesktopJson(join(resources, "desktop-shell.json")));
	if (shell.version !== version || shell.buildId !== bundle.buildId || shell.sourceSha !== bundle.sourceSha)
		throw new DesktopInstallationError(
			"invalid_artifact",
			"The Windows shell and bundled runtime identities differ.",
		);
	for (const resource of desktopResourcePathsForPlatform("win32")) {
		const info = await desktopPhysicalFileSystem.lstat(join(resources, resource));
		if (!info.isFile() || info.isSymbolicLink())
			throw new DesktopInstallationError("invalid_artifact", "A Windows app resource is not a regular file.");
		if (release && (await desktopFileSha256(join(resources, resource))) !== release.checksums[resource])
			throw new DesktopInstallationError(
				"invalid_artifact",
				"Windows resource checksums differ from the release manifest.",
			);
	}
	for (const path of [
		join(canonical, "Quarterdeck.exe"),
		host,
		join(resources, "runtime/bin/node.exe"),
		join(resources, "runtime/bin/nodeHost.exe"),
		join(resources, "runtime/installation-admission.exe"),
		join(resources, `runtime/node_modules/node-pty/prebuilds/win32-${arch}/conpty.node`),
		join(resources, `runtime/node_modules/node-pty/prebuilds/win32-${arch}/conpty_console_list.node`),
	]) {
		const info = await desktopPhysicalFileSystem.lstat(path);
		if (!info.isFile() || info.isSymbolicLink() || (await windowsPeArchitecture(path)) !== arch)
			throw new DesktopInstallationError(
				"invalid_artifact",
				"Windows app binaries do not match the requested architecture.",
			);
	}
	const bootstrap = await desktopFileSha256(join(resources, "runtime/installation-admission.exe"));
	if (
		release &&
		(bootstrap !== release.nativeAdmission.bootstrapSha256 ||
			(await desktopFileSha256(host)) !== release.nativeAdmission.hostSha256)
	)
		throw new DesktopInstallationError(
			"invalid_artifact",
			"Windows native admission provenance differs from the release manifest.",
		);
	if (
		(await desktopFileSha256(join(canonical, "Quarterdeck.exe"))) !== bootstrap ||
		(await desktopFileSha256(join(resources, "runtime/bin/node.exe"))) !== bootstrap
	)
		throw new DesktopInstallationError(
			"invalid_artifact",
			"Windows admission entrypoints differ from their verified helper.",
		);
	return {
		appPath: canonical,
		bundle,
		appAsarSha256: await desktopFileSha256(join(resources, "app.asar")),
		appTreeSha256: tree,
		launcherSha256: bootstrap,
	};
}
