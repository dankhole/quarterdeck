import { randomUUID } from "node:crypto";
import { lstat } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { DesktopInstallationOwner } from "../shared/desktop-installation-contract.js";
import { desktopBuildsMatch } from "../shared/desktop-installation-contract.js";
import { DesktopInstallationError } from "./errors.js";
import { copyDesktopTreePrivate, desktopFileSha256, readDesktopJson } from "./files.js";
import { desktopBootstrapPath } from "./layout.js";
import {
	type DesktopReleaseManifest,
	desktopContainerName,
	maximumDesktopManifestBytes,
	validateDesktopReleaseManifest,
} from "./metadata.js";
import { desktopReleaseAssetUrl } from "./network.js";
import { resolveDesktopReleaseDistribution } from "./owner.js";
import type { ManagedDesktopInstallationReceipt } from "./receipt.js";
import { desktopApplicationBundleId, desktopLaunchProtocolVersion } from "./receipt.js";
import { writeDesktopJson } from "./transaction-files.js";
import type {
	DesktopInstallationArchitecture,
	DesktopInstallationDependencies,
	EnsureDesktopInstallationOptions,
} from "./types.js";
import { inspectWindowsDesktopApp } from "./windows-app-identity.js";
import { extractWindowsDesktopArchive } from "./windows-archive.js";
import { windowsDesktopTreeFingerprint } from "./windows-tree-fingerprint.js";

export async function prepareWindowsDesktopInstallation(
	stage: string,
	appPath: string,
	owner: DesktopInstallationOwner,
	options: EnsureDesktopInstallationOptions,
	arch: DesktopInstallationArchitecture,
	dependencies: DesktopInstallationDependencies,
) {
	let sourcePath: string;
	let release: DesktopReleaseManifest | undefined;
	let provenance: ManagedDesktopInstallationReceipt["release"] = null;
	if (options.from) sourcePath = resolve(options.from);
	else {
		const manifestPath = join(stage, "release-manifest.json");
		await dependencies.download(
			desktopReleaseAssetUrl(options.version, `artifact-manifest-win32-${arch}.json`),
			manifestPath,
			maximumDesktopManifestBytes,
		);
		release = validateDesktopReleaseManifest(
			await readDesktopJson(manifestPath),
			options.version,
			arch,
			await resolveDesktopReleaseDistribution(owner, "win32"),
		);
		const name = desktopContainerName(options.version, arch, "win32");
		const artifact = release.artifacts.find((entry) => entry.path === name);
		if (!artifact) throw new DesktopInstallationError("invalid_artifact", "The matching Windows ZIP is missing.");
		const archive = join(stage, name);
		await dependencies.download(desktopReleaseAssetUrl(options.version, name), archive, artifact.bytes);
		const info = await lstat(archive);
		if (!info.isFile() || info.size !== artifact.bytes || (await desktopFileSha256(archive)) !== artifact.sha256)
			throw new DesktopInstallationError(
				"invalid_artifact",
				"The Windows ZIP checksum or byte length differs from its manifest.",
			);
		sourcePath = join(stage, "unpacked");
		await extractWindowsDesktopArchive(archive, sourcePath);
		provenance = {
			manifestSha256: await desktopFileSha256(manifestPath),
			containerName: name,
			containerSha256: artifact.sha256,
			sourceSha: release.sourceSha,
		};
	}
	const source = await inspectWindowsDesktopApp(sourcePath, options.version, arch, release);
	if (options.from && source.bundle.distributionMode !== "local")
		throw new DesktopInstallationError(
			"invalid_artifact",
			"Explicit Windows imports require a paired local candidate.",
		);
	if (!desktopBuildsMatch(owner, source.bundle, release ? "release" : "local"))
		throw new DesktopInstallationError(
			"invalid_artifact",
			"The Windows app and owning npm CLI must share the exact build identity.",
		);
	const stagedApp = join(stage, "Quarterdeck.app");
	await copyDesktopTreePrivate(source.appPath, stagedApp);
	const fingerprint = await windowsDesktopTreeFingerprint(stagedApp);
	const copy = await inspectWindowsDesktopApp(stagedApp, options.version, arch, release);
	if (source.appTreeSha256 !== copy.appTreeSha256)
		throw new DesktopInstallationError(
			"invalid_artifact",
			"The Windows source app changed or its copy is incomplete.",
		);
	// Record a fingerprint only when it describes the same staged files we fully verified.
	const windowsAppFingerprint =
		fingerprint && (await windowsDesktopTreeFingerprint(stagedApp)) === fingerprint ? fingerprint : undefined;
	const receipt: ManagedDesktopInstallationReceipt = {
		schemaVersion: 2,
		managedBy: "quarterdeck-npm",
		installId: randomUUID(),
		version: options.version,
		arch,
		source: release ? "release" : "local",
		distributionMode: release ? "windows-unsigned" : "local",
		appPath,
		bundleId: desktopApplicationBundleId,
		buildId: copy.bundle.buildId,
		appAsarSha256: copy.appAsarSha256,
		appTreeSha256: copy.appTreeSha256,
		windowsAppFingerprint,
		windowsLauncherSha256: windowsAppFingerprint ? copy.launcherSha256 : undefined,
		desktopLaunchProtocolVersion,
		updatesEnabled: false,
		owner,
		signing: { verified: false, teamId: null },
		release: provenance,
	};
	await writeDesktopJson(join(stage, "receipt.json"), receipt);
	return { receipt, stagedApp, bootstrap: desktopBootstrapPath(stagedApp, "win32") };
}
